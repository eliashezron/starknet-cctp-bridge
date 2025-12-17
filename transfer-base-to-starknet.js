// Transfer 0.01 USDC from Base Sepolia to Starknet Sepolia using CCTPv2
import "dotenv/config";
import axios from "axios";
import { Buffer } from "node:buffer";
import { createWalletClient, http, encodeFunctionData, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { RpcProvider, Account } from "starknet";

// ===== Env / config =====
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY (EVM) in .env without 0x prefix.");
const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`,
);

const STARKNET_RPC =
  process.env.STARKNET_RPC || undefined;
const STARKNET_ACCOUNT_ADDRESS = process.env.STARKNET_ACCOUNT_ADDRESS;
const STARKNET_PRIVATE_KEY = process.env.STARKNET_PRIVATE_KEY;
if (!STARKNET_ACCOUNT_ADDRESS || !STARKNET_PRIVATE_KEY) {
  throw new Error("Set STARKNET_ACCOUNT_ADDRESS and STARKNET_PRIVATE_KEY in .env");
}

const DESTINATION_STARKNET_ADDRESS =
  process.env.DESTINATION_STARKNET_ADDRESS || STARKNET_ACCOUNT_ADDRESS;

// Contracts
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"; // same on all EVM testnets
const STARKNET_MESSAGE_TRANSMITTER =
  "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8";

// Domains
const BASE_DOMAIN = 6;
const STARKNET_DOMAIN = 25;

// Transfer params
const AMOUNT = 10_000n; // 0.01 USDC (6 decimals)
const maxFee = 500n; // 0.0005 USDC fast-transfer cap
const minFinalityThreshold = 1000; // 1000 => fast transfer; set 2000 for finalized

// Helpers
const toBytes32 = (hex) => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${clean.padStart(64, "0")}`;
};

const DESTINATION_RECIPIENT_BYTES32 = toBytes32(DESTINATION_STARKNET_ADDRESS);
const DESTINATION_CALLER_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Helper: decode Circle envelopes (base64 by default, hex fallback)
const decodeEnvelope = (str) => {
  const isHex = str.startsWith("0x") || /^[0-9a-fA-F]+$/.test(str);
  return isHex ? hexToBytes(str) : Buffer.from(str, "base64");
};

// Helper: turn a <=31-byte chunk into a felt
const bytesToFelt = (chunk) => {
  if (chunk.length > 31) throw new Error("Chunk too large for bytes31");
  const hex = Buffer.from(chunk).toString("hex");
  return BigInt(`0x${hex || "0"}`);
};

// Helper: encode ByteArray as calldata layout expected by Cairo (len, data[], pending_word, pending_len)
const bytesToByteArrayCalldata = (bytes) => {
  const fullChunks = Math.floor(bytes.length / 31);
  const dataFelts = [];
  for (let i = 0; i < fullChunks; i += 1) {
    dataFelts.push(bytesToFelt(bytes.slice(i * 31, (i + 1) * 31)));
  }
  const pending = bytes.slice(fullChunks * 31);
  return [BigInt(dataFelts.length), ...dataFelts, bytesToFelt(pending), BigInt(pending.length)];
};

const baseClient = createWalletClient({
  chain: baseSepolia,
  transport: http(),
  account,
});

async function approveUSDC() {
  // Allow the TokenMessenger to spend USDC on Base
  console.log("1) Approving USDC on Base Sepolia...");
  const approveTx = await baseClient.sendTransaction({
    to: BASE_SEPOLIA_USDC,
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      functionName: "approve",
      args: [TOKEN_MESSENGER_V2, 10_000_000_000n], // 10,000 USDC allowance
    }),
  });
  console.log(`   USDC approve tx: ${approveTx}`);
}

async function burnUSDC() {
  // Burn USDC on Base and emit the cross-chain message
  console.log("2) Burning USDC on Base Sepolia (depositForBurn)...");
  const burnTx = await baseClient.sendTransaction({
    to: TOKEN_MESSENGER_V2,
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "depositForBurn",
          stateMutability: "nonpayable",
          inputs: [
            { name: "amount", type: "uint256" },
            { name: "destinationDomain", type: "uint32" },
            { name: "mintRecipient", type: "bytes32" },
            { name: "burnToken", type: "address" },
            { name: "destinationCaller", type: "bytes32" },
            { name: "maxFee", type: "uint256" },
            { name: "minFinalityThreshold", type: "uint32" },
          ],
          outputs: [],
        },
      ],
      functionName: "depositForBurn",
      args: [
        AMOUNT,
        STARKNET_DOMAIN,
        DESTINATION_RECIPIENT_BYTES32,
        BASE_SEPOLIA_USDC,
        DESTINATION_CALLER_BYTES32,
        maxFee,
        minFinalityThreshold,
      ],
    }),
  });
  console.log(`   Burn tx: ${burnTx}`);
  return burnTx;
}

async function retrieveAttestation(srcTxHash) {
  // Poll Circle Iris until the attestation for the burn message is ready
  console.log("3) Waiting for attestation from Circle Iris...");
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${BASE_DOMAIN}?transactionHash=${srcTxHash}`;
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
  // Mint on Starknet by calling MessageTransmitterV2.receive_message with the message + attestation
  console.log("4) Minting USDC on Starknet Sepolia (receive_message)...");
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
  // Happy-path flow: approve → burn → await attestation → mint on Starknet
  console.log(`Source (Base Sepolia) sender: ${account.address}`);
  console.log(`Destination (Starknet Sepolia) recipient: ${DESTINATION_STARKNET_ADDRESS}`);
  await approveUSDC();
  const burnTx = await burnUSDC();
  const attestation = await retrieveAttestation(burnTx);
  await mintOnStarknet(attestation);
  console.log("✅ Transfer complete: 0.01 USDC bridged Base → Starknet (Sepolia)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
