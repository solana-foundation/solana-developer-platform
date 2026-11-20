# Earn quickstart

Run the flow without an account, API key, wallet, dependencies or funds:

```bash
git clone --branch codex/earn-core-api https://github.com/solana-foundation/solana-developer-platform.git
cd solana-developer-platform/examples/earn-quickstart
node dry-run.ts
node dry-run.ts --connected-wallet
```

Use Node.js 24.22.1 or newer. Both commands use local fake responses and a fake
signature. They never contact SDP or Solana. The second shows optional BYOK
signing through an existing connected wallet. Expected final output:

```text
Result: completed; 2 saved mutation requests.
```

This PR changes the core contract. The examples describe this branch, not a
claim that its routes are already deployed. Earn follows normal release-channel
rules. The canonical devnet API is `https://api-devnet.solana.com`; use live
requests only after your target deployment runs this version.

## Use your own wallet

[Create a devnet project key](https://platform-devnet.solana.com/dashboard?return_to=%2Fdashboard%2Fapi-keys%2Fnew)
with Earn Execute (which includes Read). Creating a key requires sign-in;
reading docs and running the dry-run do not. Keep the key on your server.

[`earn.ts`](./earn.ts) uses native `fetch`: prepare a deposit, sign outside SDP,
submit its exact bytes, then poll the operation. Your app owns wallet connection
and review UI. Any compatible Solana wallet works, including a wallet from
your Privy integration. No SDP wallet registration is required.

The signing callback accepts SDP's base64 unsigned transaction and returns the
complete signed transaction as base64. Adapt your wallet SDK at that boundary;
this example does not hold wallet keys or implement connection UI.

`dry-run.ts` supplies runnable callbacks. In your application, replace its fake
transport with native `fetch`, use a real strategy and supported mint, and
supply your real review, signing and durable-storage callbacks. Keep
`source: { ownerAddress }` for caller signing.

For optional BYOK signing, use `source: { walletId }` for a wallet already
connected in SDP and omit the signing callback. Submission omits signed bytes;
SDP requests the configured provider's signature. If `sign_in_provider` is
returned, show its instructions and keep polling. Do not submit again.

## Recovery and status

The dry-run's fake signature, review and in-memory storage are for local
experimentation only. A live app must durably save request bodies, keys and
signed bytes before sending. After a lost response, recover the same operation
and exact saved request. Do not rerun the whole deposit with new keys.

`202` means accepted. `queued`, `awaiting_signature`, `submitted` and `settling`
are pending. Only `completed` establishes verified delivery. A queued redemption
request is not payout. After submit acceptance, refresh and cancellation are
unavailable. A definitive failure is terminal; uncertain outcomes keep the same
operation. This example adds neither refresh nor cancel to a normal deposit.

Run `node --test earn.test.ts`. These local tests do not verify a live wallet,
provider, chain settlement or production environment.
