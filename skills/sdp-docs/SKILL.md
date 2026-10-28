---
name: sdp-docs
description: Answer questions and write code for Solana Developer Platform (SDP) from its public docs and OpenAPI contract. Use when building against the SDP REST API at api.solana.com, or when asked how SDP environments, API keys, idempotency or transaction signing work.
---

# Solana Developer Platform docs

Read the published SDP docs before you answer or write code. This skill only reads: it never calls the SDP API or handles an API key, and the user runs every request with their own key.

## Where to read

- [llms.txt](https://platform.solana.com/docs/ai/llms.txt): every published page, one line each. Find the page for the task here.
- Any docs page as Markdown: add `.md` to its URL, as in https://platform.solana.com/docs/developing-with-sdp/idempotency.md.
- [llms-full.txt](https://platform.solana.com/docs/ai/llms-full.txt): every page in one file.
- [OpenAPI](https://api.solana.com/openapi.json): every public route, field and error code. Take paths, fields and enum values from it, never from memory.

These files list what the platform publishes. A route or page they leave out is not public: don't use it, and don't infer one from SDP's source code.

## Grounding rules

1. **The project picks the network.** A sandbox project runs on devnet and a production project on mainnet-beta. An API key belongs to one project and reaches only its network; no request field or key format names the network. Build against a sandbox key, then go live by swapping in a production key. [Environments](https://platform.solana.com/docs/developing-with-sdp.md)
2. **Keys hold explicit grants.** Every route performs one action, `module.verb`, and a key may call it only when it holds that action: there are no roles and no wildcards. `manage` and `execute` include the same module's `read`, and nothing else implies another action. A missing grant is `403 INSUFFICIENT_PERMISSIONS`, with `error.details.action` naming it. A key never administers keys, members, the organization or projects, and its wallet scope limits which custody wallets SDP signs with for it. [Manage API Keys](https://platform.solana.com/docs/developing-with-sdp/manage-api-keys.md), [Authentication](https://platform.solana.com/docs/developing-with-sdp/authentication.md)
3. **Send an `Idempotency-Key` on every mutation that accepts one.** Routes that move money require it (`400 IDEMPOTENCY_KEY_REQUIRED`). Make one key per logical operation, store it before the first send and reuse it on every retry; a new operation gets a new key. A different request under the same key is `422 IDEMPOTENCY_KEY_REUSED`, and `409 IDEMPOTENCY_KEY_IN_FLIGHT` means wait, then retry with the same key. To learn an outcome, read the resource with `GET`: never resend a request to find out. [Idempotency](https://platform.solana.com/docs/developing-with-sdp/idempotency.md)
4. **Execute signs inside SDP; prepare hands you a transaction.** An execute route builds the transaction, signs it with a custody wallet in the project and submits it. A `prepare` route returns an unsigned transaction for a signer outside SDP to sign and submit. It carries a recent blockhash and soon expires, so sign and submit it right away, and prepare again instead of reusing an old one. Use execute unless the signer must stay outside SDP. [Execution model](https://platform.solana.com/docs/developing-with-sdp.md)

## API basics

- Base URL `https://api.solana.com`. Send the key as `Authorization: Bearer <key>`; current keys start with `sf_`.
- A success wraps its payload as `{ "data": ..., "meta": { "requestId": ... } }`, and an error is `{ "error": { "code": ..., "message": ... } }`. Branch on `error.code`, and quote `meta.requestId` when reporting a problem.
- Keep the key out of code, prompts and logs: read it from an environment variable such as `SDP_API_KEY`.
