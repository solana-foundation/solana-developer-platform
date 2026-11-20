# Earn quickstart

Prepare, sign, submit and poll one Earn deposit with native `fetch`, in one
function: [`earn.ts`](./earn.ts). The
[quickstart guide](https://platform-devnet.solana.com/docs/earn/quickstart)
walks through the same calls with curl.

## Run it locally

`dry-run.ts` answers with local fake responses and a fake signature, so it
needs no API key, wallet, dependencies or funds:

```bash
git clone https://github.com/solana-foundation/solana-developer-platform.git
cd solana-developer-platform/examples/earn-quickstart
node dry-run.ts
```

It needs Node.js 24.22.1 or newer, and ends with:

```text
Result: completed
```

## Use it with your wallet

[Create a devnet API key](https://platform-devnet.solana.com/dashboard?return_to=%2Fdashboard%2Fapi-keys%2Fnew)
with Earn Execute, which includes Read, and keep it on your server. Then:

```ts
import {
  createKeyPairFromBytes,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  signTransaction,
} from "@solana/kit";
import { deposit } from "./earn.ts";

const keyPair = await createKeyPairFromBytes(secretKey); // The owner's 64-byte keypair.
const operation = await deposit({
  apiUrl: "https://api-devnet.solana.com",
  apiKey: process.env.SDP_API_KEY,
  deposit: {
    strategyId: "<strategy-id>",
    source: { ownerAddress: "<your-wallet-address>" },
    amount: { mint: "<token-mint>", value: "10" },
  },
  idempotencyKey: savedKey,
  sign: async (transaction) => {
    const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
    return getBase64EncodedWireTransaction(await signTransaction([keyPair], unsigned));
  },
});
```

`sign` gets the unsigned transaction and the operation: show `operation.terms`
to the customer, then return the owner's signed transaction, base64-encoded. In
a browser app, hand the transaction to your wallet's `signTransaction` instead;
any Solana wallet works, and SDP never needs it registered.

Generate `idempotencyKey` once per deposit and save it before calling. If the
process dies or a response is lost, call `deposit` again with the same key: it
replays the same requests instead of depositing twice. Replaying a submit needs
the same signed bytes, which a local keypair reproduces; if your signer's bytes
can differ, save what `sign` returns and return the saved bytes on a retry.

`deposit` returns when the operation is `completed`, `failed` or `cancelled`,
or after 60 polls; a pending result means keep polling the same operation.
Run the tests with `node --test earn.test.ts`.
