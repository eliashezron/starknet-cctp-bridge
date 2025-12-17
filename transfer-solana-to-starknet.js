// Bridge 0.01 USDC from Solana (devnet) to Starknet Sepolia via CCTPv2
import "dotenv/config";
import axios from "axios";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "bn.js";
import { PublicKey, Keypair, SystemProgram, Connection, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { RpcProvider, Account } from "starknet";

// ===== Env / config =====
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const SOLANA_PRIVATE_KEY_B58 = process.env.SOLANA_PRIVATE_KEY_B58;
if (!SOLANA_PRIVATE_KEY_B58) throw new Error("Set SOLANA_PRIVATE_KEY_B58 (base58) in .env");
const SOLANA_USDC_MINT =
  process.env.SOLANA_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // USDC devnet
const SOLANA_USDC_ACCOUNT = process.env.SOLANA_USDC_ACCOUNT;

const STARKNET_RPC = process.env.STARKNET_RPC;
const STARKNET_ACCOUNT_ADDRESS = process.env.STARKNET_ACCOUNT_ADDRESS;
const STARKNET_PRIVATE_KEY = process.env.STARKNET_PRIVATE_KEY;
if (!STARKNET_RPC || !STARKNET_ACCOUNT_ADDRESS || !STARKNET_PRIVATE_KEY) {
  throw new Error("Set STARKNET_RPC, STARKNET_ACCOUNT_ADDRESS, STARKNET_PRIVATE_KEY in .env");
}

const DESTINATION_STARKNET_ADDRESS =
  process.env.DESTINATION_STARKNET_ADDRESS || STARKNET_ACCOUNT_ADDRESS;
const DESTINATION_CALLER = process.env.DESTINATION_CALLER_BASE58 || PublicKey.default.toBase58();

const AMOUNT = BigInt(process.env.AMOUNT || 10_000); // 0.01 USDC (6 decimals)
const MAX_FEE = BigInt(process.env.MAX_FEE || 500); // fast-transfer cap
const MIN_FINALITY_THRESHOLD = Number(process.env.MIN_FINALITY_THRESHOLD || 1000);

// Programs / domains
const TOKEN_MESSENGER_MINTER_V2_ID = new PublicKey(
  process.env.TOKEN_MESSENGER_MINTER_V2_ID || "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
);
const MESSAGE_TRANSMITTER_V2_ID = new PublicKey(
  process.env.MESSAGE_TRANSMITTER_V2_ID || "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
);
const TOKEN_MESSENGER_MINTER_V2_IDL_URL =
  process.env.TOKEN_MESSENGER_MINTER_V2_IDL_URL ||
  "https://raw.githubusercontent.com/circlefin/solana-cctp-contracts/master/examples/target/idl/token_messenger_minter_v2.json";
const STARKNET_MESSAGE_TRANSMITTER =
  process.env.STARKNET_MESSAGE_TRANSMITTER ||
  "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8";

const SOLANA_DOMAIN = 5;
const STARKNET_DOMAIN = 25;

// ===== Helpers =====
// Decode Iris payloads that may be hex or base64.
const decodeEnvelope = (str) => {
  const isHex = str.startsWith("0x") || /^[0-9a-fA-F]+$/.test(str);
  return isHex ? Buffer.from(str.replace(/^0x/, ""), "hex") : Buffer.from(str, "base64");
};

// Split bytes into felts for Starknet calldata (31-byte chunks + tail length).
const bytesToFelt = (chunk) => {
  if (chunk.length > 31) throw new Error("Chunk too large for bytes31");
  const hex = Buffer.from(chunk).toString("hex");
  return BigInt(`0x${hex || "0"}`);
};

const bytesToByteArrayCalldata = (bytes) => {
  const fullChunks = Math.floor(bytes.length / 31);
  const dataFelts = [];
  for (let i = 0; i < fullChunks; i += 1) {
    dataFelts.push(bytesToFelt(bytes.slice(i * 31, (i + 1) * 31)));
  }
  const pending = bytes.slice(fullChunks * 31);
  return [BigInt(dataFelts.length), ...dataFelts, bytesToFelt(pending), BigInt(pending.length)];
};

const u32ToLeBuffer = (num) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(num);
  return buf;
};

const starknetAddressToBase58Pubkey = (addr) => {
  const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
  const padded = hex.padStart(64, "0");
  return new PublicKey(Buffer.from(padded, "hex"));
};

// Minimal PDA derivations needed for deposit_for_burn.
const findProgramAddress = (label, programId, extraSeeds = []) => {
  const seeds = [Buffer.from(anchor.utils.bytes.utf8.encode(label))];
  extraSeeds.forEach((seed) => {
    if (typeof seed === "string") {
      seeds.push(Buffer.from(anchor.utils.bytes.utf8.encode(seed)));
    } else if (Array.isArray(seed)) {
      seeds.push(Buffer.from(seed));
    } else if (Buffer.isBuffer(seed)) {
      seeds.push(seed);
    } else {
      seeds.push(seed.toBuffer());
    }
  });
  const [publicKey, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { publicKey, bump };
};

const getDepositForBurnPdasV2 = (usdcMint, ownerPk, programIds) => {
  const { tokenMessengerMinterProgramId, messageTransmitterProgramId } = programIds;
  const messageTransmitterAccount = findProgramAddress("message_transmitter", messageTransmitterProgramId);
  const tokenMessengerAccount = findProgramAddress(
    "token_messenger",
    tokenMessengerMinterProgramId,
  );
  const tokenMinterAccount = findProgramAddress("token_minter", tokenMessengerMinterProgramId);
  const localToken = findProgramAddress(
    "local_token",
    tokenMessengerMinterProgramId,
    [usdcMint.toBuffer()],
  );
  const authorityPda = findProgramAddress("sender_authority", tokenMessengerMinterProgramId);
  const denylistAccount = findProgramAddress(
    "denylist_account",
    tokenMessengerMinterProgramId,
    [ownerPk.toBuffer()],
  );
  return {
    messageTransmitterAccount,
    tokenMessengerAccount,
    tokenMinterAccount,
    localToken,
    authorityPda,
    denylistAccount,
  };
};

const solanaKeypair = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATE_KEY_B58));
const connection = new Connection(SOLANA_RPC, "confirmed");
const wallet = new anchor.Wallet(solanaKeypair);
const provider = new anchor.AnchorProvider(connection, wallet, {
  preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

async function fetchIdlWithFallback(programId, url) {
  const name = programId.toBase58();
  try {
    const idl = await anchor.Program.fetchIdl(programId, provider);
    if (idl) return idl;
    console.log(`   On-chain IDL for ${name} not found; falling back to ${url}`);
  } catch (err) {
    console.log(`   Failed to fetch on-chain IDL for ${name}: ${err.message}; falling back to ${url}`);
  }

  const { data } = await axios.get(url);
  if (!data) throw new Error(`Unable to load IDL for ${name} from ${url}`);
  return data;
}

async function getIdls() {
  const tokenMessengerIdl = await fetchIdlWithFallback(
    TOKEN_MESSENGER_MINTER_V2_ID,
    TOKEN_MESSENGER_MINTER_V2_IDL_URL,
  );
  return { tokenMessengerIdl };
}

const remoteTokenMessengerDiscriminator = crypto
  .createHash("sha256")
  .update("account:RemoteTokenMessenger")
  .digest()
  .slice(0, 8);

async function getRemoteTokenMessengerAccount(domain, tokenMessengerIdl) {
  const coder = new anchor.BorshAccountsCoder(tokenMessengerIdl);
  const filters = [
    { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(remoteTokenMessengerDiscriminator) } },
    { memcmp: { offset: 8, bytes: anchor.utils.bytes.bs58.encode(u32ToLeBuffer(domain)) } },
  ];

  // Try current RPC first; fall back to public devnet if getProgramAccounts is blocked.
  const fallback = connection.rpcEndpoint === "https://api.devnet.solana.com"
    ? []
    : [new Connection("https://api.devnet.solana.com", "confirmed")];
  const candidates = [connection, ...fallback];

  for (const conn of candidates) {
    try {
      const accounts = await conn.getProgramAccounts(TOKEN_MESSENGER_MINTER_V2_ID, { filters });
      if (accounts.length) {
        const decoded = coder.decode("RemoteTokenMessenger", accounts[0].account.data);
        return { pubkey: accounts[0].pubkey, decoded };
      }
    } catch (err) {
      console.log(`   getProgramAccounts failed on ${conn.rpcEndpoint}: ${err.message}`);
    }
  }

  throw new Error(
    `RemoteTokenMessenger account for domain ${domain} not found. Ensure destination domain is registered on Solana.`,
  );
}

async function depositForBurnOnSolana(tokenMessengerIdl, mintRecipient) {
  console.log("1) Burning USDC on Solana (depositForBurn)");
  const usdcMint = new PublicKey(SOLANA_USDC_MINT);
  const derivedAta = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  const envTokenAccount = SOLANA_USDC_ACCOUNT ? new PublicKey(SOLANA_USDC_ACCOUNT) : null;

  // Prefer env account; fall back to ATA. If env points to mint, switch to ATA.
  let userTokenAccount = envTokenAccount || derivedAta;
  if (envTokenAccount) {
    const info = await connection.getAccountInfo(envTokenAccount);
    const looksLikeMint = info?.data?.length === 82 && info?.owner?.equals(TOKEN_PROGRAM_ID);
    if (looksLikeMint) {
      console.log("   Provided SOLANA_USDC_ACCOUNT is a mint; switching to ATA for wallet.");
      userTokenAccount = derivedAta;
    }
  } else {
    console.log("   No SOLANA_USDC_ACCOUNT provided; using derived ATA for wallet.");
  }

  const parsedAccount = await connection.getParsedAccountInfo(userTokenAccount);
  const tokenInfo = parsedAccount.value?.data?.parsed?.info;
  if (!tokenInfo) {
    throw new Error(`Token account ${userTokenAccount.toBase58()} is not a parsed SPL token account.`);
  }
  if (tokenInfo.mint !== usdcMint.toBase58()) {
    throw new Error(
      `Token account ${userTokenAccount.toBase58()} mint ${tokenInfo.mint} does not match USDC mint ${usdcMint.toBase58()}.`,
    );
  }
  const destinationCaller = new PublicKey(DESTINATION_CALLER);
  const messageSentEventAccount = Keypair.generate();

  const pdas = getDepositForBurnPdasV2(usdcMint, wallet.publicKey, {
    tokenMessengerMinterProgramId: TOKEN_MESSENGER_MINTER_V2_ID,
    messageTransmitterProgramId: MESSAGE_TRANSMITTER_V2_ID,
  });

  const remoteTokenMessenger = await getRemoteTokenMessengerAccount(
    STARKNET_DOMAIN,
    tokenMessengerIdl,
  );
  console.log(`   Remote token messenger PDA: ${remoteTokenMessenger.pubkey.toBase58()}`);

  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    TOKEN_MESSENGER_MINTER_V2_ID,
  );

  const ixDef = tokenMessengerIdl.instructions.find((ix) => ix.name === "deposit_for_burn");
  if (!ixDef) throw new Error("deposit_for_burn instruction not found in IDL");

  // Manually encode instruction data and accounts to avoid Anchor client issues.
  const ixCoder = new anchor.BorshInstructionCoder(tokenMessengerIdl);
  const data = ixCoder.encode("deposit_for_burn", {
    params: {
      amount: new BN(AMOUNT.toString()),
      destination_domain: STARKNET_DOMAIN,
      mint_recipient: mintRecipient,
      destination_caller: destinationCaller,
      max_fee: new BN(MAX_FEE.toString()),
      min_finality_threshold: MIN_FINALITY_THRESHOLD,
    },
  });

  const accountMap = {
    owner: wallet.publicKey,
    event_rent_payer: wallet.publicKey,
    event_authority: eventAuthority,
    sender_authority_pda: pdas.authorityPda.publicKey,
    burn_token_account: userTokenAccount,
    denylist_account: pdas.denylistAccount.publicKey,
    message_transmitter: pdas.messageTransmitterAccount.publicKey,
    token_messenger: pdas.tokenMessengerAccount.publicKey,
    remote_token_messenger: remoteTokenMessenger.pubkey,
    token_minter: pdas.tokenMinterAccount.publicKey,
    local_token: pdas.localToken.publicKey,
    burn_token_mint: usdcMint,
    message_sent_event_data: messageSentEventAccount.publicKey,
    message_transmitter_program: MESSAGE_TRANSMITTER_V2_ID,
    token_messenger_minter_program: TOKEN_MESSENGER_MINTER_V2_ID,
    program: TOKEN_MESSENGER_MINTER_V2_ID,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };

  const keys = ixDef.accounts.map((acct) => {
    const pubkey = accountMap[acct.name];
    if (!pubkey) throw new Error(`Missing account mapping for ${acct.name}`);
    const isWritable = acct.isMut ?? acct.writable ?? false;
    const isSigner = acct.isSigner ?? acct.signer ?? false;
    return { pubkey, isWritable, isSigner };
  });

  const ix = new TransactionInstruction({
    programId: TOKEN_MESSENGER_MINTER_V2_ID,
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await provider.sendAndConfirm(tx, [messageSentEventAccount]);
  console.log(`   Solana tx signature: ${sig}`);
  return sig;
}

async function retrieveAttestation(srcTxHash) {
  console.log("2) Waiting for attestation from Circle Iris...");
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${SOLANA_DOMAIN}?transactionHash=${srcTxHash}`;
  while (true) {
    try {
      const response = await axios.get(url);
      if (response.data?.messages?.[0]?.status === "complete") {
        console.log("   Attestation ready.");
        return response.data.messages[0];
      }
      console.log("   Not ready yet, retrying in 5s...");
    } catch (err) {
      console.log(`   Iris polling error: ${err.message} (retrying in 5s)...`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function mintOnStarknet(attestation) {
  console.log("3) Minting USDC on Starknet Sepolia (receive_message)...");
  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });
  const starknetAccount = new Account({
    provider,
    address: STARKNET_ACCOUNT_ADDRESS.toLowerCase(),
    signer: STARKNET_PRIVATE_KEY.startsWith("0x")
      ? STARKNET_PRIVATE_KEY
      : `0x${STARKNET_PRIVATE_KEY}`,
  });

  const messageBytes = decodeEnvelope(attestation.message);
  const attestationBytes = decodeEnvelope(attestation.attestation);
  console.log(
    `   message bytes=${messageBytes.length}, attestation bytes=${attestationBytes.length}`,
  );

  const calldata = [
    ...bytesToByteArrayCalldata(messageBytes),
    ...bytesToByteArrayCalldata(attestationBytes),
  ];

  const call = {
    contractAddress: STARKNET_MESSAGE_TRANSMITTER,
    entrypoint: "receive_message",
    calldata,
  };

  const tx = await starknetAccount.execute([call]);
  console.log(`   Starknet tx hash: ${tx.transaction_hash}`);
  await provider.waitForTransaction(tx.transaction_hash);
  console.log("   Starknet mint confirmed.");
}

async function main() {
  console.log(`Source (Solana) sender: ${wallet.publicKey.toBase58()}`);
  console.log(`Destination (Starknet Sepolia) recipient: ${DESTINATION_STARKNET_ADDRESS}`);
  const { tokenMessengerIdl } = await getIdls();
  const mintRecipient = starknetAddressToBase58Pubkey(DESTINATION_STARKNET_ADDRESS);

  const burnSig = await depositForBurnOnSolana(tokenMessengerIdl, mintRecipient);
  const attestation = await retrieveAttestation(burnSig);
  await mintOnStarknet(attestation);
  console.log("✅ Transfer complete: 0.01 USDC bridged Solana → Starknet (Sepolia)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
