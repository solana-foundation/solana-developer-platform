# Intents playground

A local explorer for the intents registry: an interface is an endpoint, an implementation is a
provider behind it, and an intent is the request. It reads the registry on a local surfnet through
`sdp-intents-service`, and it is never deployed. `packages/sdp-intents/DESIGN.md`, section 4.14,
describes it.

## Run it

Each step runs in its own terminal, from the repository root.

1. Start a surfnet that forks mainnet:

   ```sh
   surfpool start --network mainnet --no-tui --no-studio --no-deploy --airdrop-amount 0
   ```

2. Place the programs, fund the playground wallets, and publish the definitions. `just playground`
   in `intents/` runs this step and the next one:

   ```sh
   cd intents
   just build-programs idl fetch-zolana
   cargo build -p sdp-intents-cli -p sdp-intents-service -p sdp-intents-test-provider -p sdp-intents-local-wallet
   node programs/tools/deploy-surfnet.mjs
   node e2e/playground.mjs
   ```

3. Start the Privacy Rings indexer and prover, the Jupiter wrapper, the stand-in provider, the
   local wallet, and the service. The wallet holds the playground's keys: it builds Privacy Rings
   spends when the page asks, checks each spend's statement before it signs, and sends. The service
   holds no key and never calls the wallet. It runs a prover for a build that asks it to prove:

   ```sh
   cd intents
   node programs/tools/zolana-services.mjs &
   node adapters/jupiter.mjs &
   ./target/debug/sdp-intents-test-provider &
   ./target/debug/sdp-intents-local-wallet --wallets target/playground/wallets --ring-indexer http://127.0.0.1:8784 --ring-asset EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v &
   ./target/debug/sdp-intents-service --allow-tamper --prover http://127.0.0.1:3001
   ```

4. Build the verifier module, start the playground, then open <http://localhost:5178>:

   ```sh
   pnpm --filter @sdp/intents-verifier build:wasm
   pnpm --filter intents-playground dev
   ```

`just idl` writes the IDL of each Anchor program, and `deploy-surfnet.mjs` places each IDL beside
its program, so Solana Explorer decodes the registry's instructions and errors.

The wallets are new keys in `intents/target/playground/wallets`, funded by cheatcodes. They hold
nothing on a real cluster.

## What it shows

- The registry: each organization's interfaces, and the implementations behind each one. A switch
  shows unapproved implementations.
- The interface page: the display template as the title, the inputs as a form, the postconditions
  as guarantees, and each implementation with whether its `applies` checks hold.
- Solana Privacy Rings, on an interface with a shielded implementation: each wallet's private
  balances in the default ring, and a button that shields 1 SOL. `private.shield`, the
  `privacy-rings-transfer` implementation of `token.transfer`, and `private.unshield` move SOL and
  SPL tokens into, inside, and out of the ring. Each implementation states its spend: the notes it
  creates, and what it deposits and withdraws. `privacy-rings-shield-and-transfer` is a flow: it
  shields public funds, then transfers them. The tree lists the circuit that each spend proves
  with.
- Intent: the intent JSON and the `POST /v1/intents` request as curl, TypeScript, and Rust. An
  amount is a decimal, which the service converts with the mint's decimals.
- The loop: every intent runs the same loop, for one transaction or many (`DESIGN.md`, 4.1). Each
  call shows its curl and its answer, and `next` says what to do: have the wallet build a shielded
  spend, proved in the wallet or on the service, sign each step, wait for its condition, or nothing, because the flow is done. For a step to sign, the panel shows its message,
  each instruction with its part of the segment, and the compute units. `Verify` runs
  `@sdp/intents-verifier` in the browser. It reads the registry from the surfnet's RPC through the
  dev server's `/rpc`, never from the service. `Sign and send` stays off until the verifier proves
  the step's message, and signs with the local wallets. A request of one step ends there: its sign
  says `then: done`, so the calls stay folded and nothing asks for `continue`. A flow shows its
  steps as a bar, and the next call sends `progress` back with the signatures. "Run the loop for
  me" makes every call without a click. The calls stay in the browser's storage, so a refresh
  continues the flow.
- Deprecation: a deprecated interface or implementation shows a badge in the tree and on its
  candidate, with its replacement and end of life, and the first answer lists the warnings.
- Interface: the selected interface, its authorities and versions, and its document as the registry holds it.
- Implementation: the selected implementation, its versions, and its document as the registry holds it.

"Tamper with the plan" makes the service change one byte of a built instruction. The verifier still
renders the plan's message, because it reads only `verify_intent`, and `verify_intent` refuses the
transaction onchain.

The Ondo implementations route through the Jupiter wrapper, at tier 2. Their side panel has a switch that
makes the wrapper also approve an attacker, which the segment's assertions refuse. The test
provider's implementation returns a transaction that the provider signed, at tier 3. Turn both onchain
checks off to accept it. The browser's verifier proves none of its instructions, because no
`verify_intent` holds them. Hastra's implementations show the request interfaces, which settle later.

A builder cannot name its rent payer as one of its own accounts yet, so a wallet that deposits into
a vault cannot also pay the fee. The playground defaults the fee payer to `alice` for that reason.
