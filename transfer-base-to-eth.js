// Transfer 0.1 USDC from Base Sepolia to Ethereum Sepolia via CCTPv2
import "dotenv/config";
import axios from "axios";
import { createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

// ===== Configuration =====
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error("Set PRIVATE_KEY in your .env file (without 0x prefix).");
}
const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`,
);

const DESTINATION_ADDRESS =
  process.env.DESTINATION_ADDRESS || account.address; // Where minted USDC lands on Ethereum Sepolia

// Contracts (testnet)
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ETHEREUM_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"; // same on all EVM testnets
const MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"; // same on all EVM testnets

// Domains
const BASE_DOMAIN = 6;
const ETHEREUM_DOMAIN = 0;

// Transfer params
const AMOUNT = 100_000n; // 0.1 USDC (6 decimals)
const maxFee = 500n; // 0.0005 USDC fast-transfer cap; raise if you see fee errors
const minFinalityThreshold = 1000; // 1000 => fast transfer; use 2000 for finalized

// Bytes32 helpers
const toBytes32Address = (address) =>
  `0x000000000000000000000000${address.slice(2)}`;
const DESTINATION_ADDRESS_BYTES32 = toBytes32Address(DESTINATION_ADDRESS);
const DESTINATION_CALLER_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Wallet clients
const baseClient = createWalletClient({
  chain: baseSepolia,
  transport: http(),
  account,
});
const sepoliaClient = createWalletClient({
  chain: sepolia,
  transport: http(),
  account,
});

async function approveUSDC() {
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
        ETHEREUM_DOMAIN,
        DESTINATION_ADDRESS_BYTES32,
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

async function mintUSDC(attestation) {
  console.log("4) Minting USDC on Ethereum Sepolia (receiveMessage)...");
  const mintTx = await sepoliaClient.sendTransaction({
    to: MESSAGE_TRANSMITTER_V2,
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "receiveMessage",
          stateMutability: "nonpayable",
          inputs: [
            { name: "message", type: "bytes" },
            { name: "attestation", type: "bytes" },
          ],
          outputs: [],
        },
      ],
      functionName: "receiveMessage",
      args: [attestation.message, attestation.attestation],
    }),
  });
  console.log(`   Mint tx: ${mintTx}`);
}

async function main() {
  console.log(`Source (Base Sepolia) sender: ${account.address}`);
  console.log(`Destination (Ethereum Sepolia) recipient: ${DESTINATION_ADDRESS}`);
  await approveUSDC();
  const burnTx = await burnUSDC();
  const attestation = await retrieveAttestation(burnTx);
  await mintUSDC(attestation);
  console.log("✅ Transfer complete: 0.1 USDC bridged Base → Ethereum (Sepolia)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
