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
   cargo build -p sdp-intents-cli -p sdp-intents-service -p sdp-intents-test-provider
   node programs/tools/deploy-surfnet.mjs
   node e2e/playground.mjs
   ```

3. Start Zolana's indexer and prover, the Jupiter wrapper, the stand-in provider, and the service
   with the playground wallets. The service signs and sends with those wallets, and builds their
   private transfers:

   ```sh
   cd intents
   node programs/tools/zolana-services.mjs &
   node adapters/jupiter.mjs &
   ./target/debug/sdp-intents-test-provider &
   ./target/debug/sdp-intents-service --wallets target/playground/wallets --ring-indexer http://127.0.0.1:8784
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
- Privacy ring: for a `shielded` implementation, each wallet's private SOL and a button that
  shields 1 SOL. `private.transfer` then sends SOL privately through Zolana.
- Intent: the intent JSON and the `prepare` request as curl, TypeScript, and Rust.
- Plan: the message, each instruction with its part of the segment, the compute units, and the RPC
  calls that the service made. `Verify` runs `@sdp/intents-verifier` in the browser. It reads the
  registry from the surfnet's RPC through the dev server's `/rpc`, never from the service. `Send`
  lands the transaction.
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
