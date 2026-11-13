# @sdp/intents-verifier

Verifies an SDP intents transaction for its signer, before it signs. It renders the plan message
that the transaction proves, and lists each instruction that no `verify_intent` segment holds. The
signer compares the message with the one that the plan shows.

The package runs the Rust verifier of `intents/crates/verifier-wasm` as WebAssembly, so TypeScript
and `sdp_intents_client::Client::verify_message` give the same answer. It reads the registry and
the accounts from the RPC that the caller names. The service that planned the transaction takes no
part. The verifier trusts the RPC, as the signer's wallet does.

```ts
import { Verifier } from "@sdp/intents-verifier";
import verifierWasm from "@sdp/intents-verifier/verifier.wasm?url";

const verifier = await Verifier.load(verifierWasm);
const verified = await verifier.verifyMessage(messageBytes, "https://api.mainnet-beta.solana.com");

if (verified.message !== plan.message || verified.unverified.length > 0) {
  throw new Error("the transaction does not prove the plan's message");
}
```

In Node, pass the bytes of `verifier.wasm` to `Verifier.load`, because `fetch` does not read files.
`Verifier.step` runs one step with no IO, for a caller that reads accounts its own way.

The verifier takes a message of any version: legacy, v0, or v1. A provider's signed transaction has
no `verify_intent`, so the verifier proves none of its instructions.

## Build

The module is not committed. Build it from the Rust crate, with the toolchain that
`intents/rust-toolchain.toml` pins:

```sh
pnpm --filter @sdp/intents-verifier build:wasm
```

## Checks

```sh
pnpm --filter @sdp/intents-verifier typecheck
pnpm --filter @sdp/intents-verifier lint
```

`intents/e2e/run.mjs` verifies every e2e plan with this package, next to the CLI and the service.
