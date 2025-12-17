# CCTP Base → Starknet (Sepolia) Quickstart

Bridge 0.01 USDC from Base Sepolia to Starknet Sepolia using Circle CCTP. The scripts handle approval, burn, attestation retrieval, and mint on the destination chain.

## Prerequisites
- Node.js 18+
- Base Sepolia: ETH for gas + testnet USDC (faucet: https://faucet.circle.com/)
- Starknet Sepolia: deployed account, ETH/STRK for gas
- `.env` filled with keys and RPCs (see below)

## Environment
Create `.env` with:
```
PRIVATE_KEY=             # EVM key (Base) with 0x prefix
BASE_SEPOLIA_RPC=        # optional
STARKNET_RPC=            # Starknet Sepolia RPC
STARKNET_ACCOUNT_ADDRESS=
STARKNET_PRIVATE_KEY=
DESTINATION_STARKNET_ADDRESS= # optional; defaults to account
```

## How CCTP works (brief)
1) Approve: allow TokenMessengerV2 to spend USDC on Base.
2) Burn: call `depositForBurn`; USDC is burned and a message is emitted.
3) Attest: Circle attesters publish an attestation via Iris for that message.
4) Mint: on Starknet, `receive_message(message, attestation)` mints USDC; total supply stays constant.

## Run the Base → Starknet flow
```bash
npm install
npm start
```
The script `transfer-base-to-starknet` logs approve, burn, attestation polling, and the Starknet mint tx hash.

## Key contracts (testnet)
- USDC Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- TokenMessengerV2 (EVM testnets): `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
- Starknet MessageTransmitterV2: `0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8`
- Domains: Base `6`, Starknet `25`

## Further reading
- Circle CCTP docs: https://developers.circle.com/cctp
