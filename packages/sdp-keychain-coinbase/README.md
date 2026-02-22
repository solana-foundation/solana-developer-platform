# @sdp/keychain-coinbase

Coinbase CDP-based signer for Solana transactions.

## Temporary Package Notice

This package is intentionally temporary and internal to SDP.
It is designed to be moved into the Solana keychain monorepo with minimal API changes.

## Installation

```bash
pnpm add @sdp/keychain-coinbase
```

## Usage

### Create and Initialize

```ts
import { CoinbaseCdpSigner } from "@sdp/keychain-coinbase";

const signer = await CoinbaseCdpSigner.create({
  apiKeyId: process.env.COINBASE_CDP_API_KEY_ID!,
  apiKeySecret: process.env.COINBASE_CDP_API_KEY_SECRET!,
  walletSecret: process.env.COINBASE_CDP_WALLET_SECRET!,
  walletId: process.env.COINBASE_CDP_WALLET_ID!,
});

console.log("Signer address:", signer.address);
```

### Sign Messages

```ts
import { createSignableMessage } from "@solana/signers";

const message = createSignableMessage("Hello, Coinbase CDP");
const [signatures] = await signer.signMessages([message]);
```

### Sign Transactions

```ts
const [signatures] = await signer.signTransactions([transaction]);
```

### Check Availability

```ts
const available = await signer.isAvailable();
console.log("Coinbase CDP available:", available);
```

## Config

- `apiKeyId` (string, required): Coinbase CDP API key id.
- `apiKeySecret` (string, required): Coinbase CDP API key secret (PEM or base64 Ed25519 keypair bytes).
- `walletSecret` (string, required): Coinbase CDP wallet secret (base64 PKCS#8 private key bytes).
- `walletId` (string, required): Solana wallet/account address used by CDP signing endpoints.
- `apiBaseUrl` (string, optional): Defaults to `https://api.cdp.coinbase.com/platform`.
- `requestDelayMs` (number, optional): Delay in milliseconds between concurrent requests.

## Test Env Vars

- `COINBASE_CDP_API_KEY_ID`
- `COINBASE_CDP_API_KEY_SECRET`
- `COINBASE_CDP_WALLET_SECRET`
- `COINBASE_CDP_WALLET_ID`
- `COINBASE_CDP_API_BASE_URL` (optional)
- `COINBASE_CDP_REQUEST_DELAY_MS` (optional)
