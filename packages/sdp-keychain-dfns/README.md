# @sdp/keychain-dfns

Temporary internal DFNS signer package for Solana keychain compatibility.

## Status

- `getPublicKey` flow: implemented (reads wallet address from DFNS API client)
- `signTransactions` / `signMessages`: implemented via DFNS key signatures API

## Usage

```ts
import { DfnsSigner } from "@sdp/keychain-dfns";

const signer = await DfnsSigner.create({
  client: dfnsClient,
  walletId: "dfns_<walletId>",
});

console.log(signer.address);
```

## Notes

- This package expects an injected DFNS API client with `wallets.getWallet`.
- Wallet IDs may be passed either as raw DFNS IDs or SDP-normalized `dfns_` IDs.
