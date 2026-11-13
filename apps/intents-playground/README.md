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
   just build-programs
   cargo build -p sdp-intents-cli -p sdp-intents-service -p sdp-intents-test-provider
   (cd programs && node deploy-surfnet.mjs)
   node e2e/playground.mjs
   ```

3. Start the Jupiter wrapper, the stand-in provider, and the service with the playground wallets.
   The service signs and sends with those wallets:

   ```sh
   cd intents
   node adapters/jupiter.mjs &
   ./target/debug/sdp-intents-test-provider &
   ./target/debug/sdp-intents-service --wallets target/playground/wallets
   ```

4. Start the playground, then open <http://localhost:5178>:

   ```sh
   pnpm --filter intents-playground dev
   ```

The wallets are new keys in `intents/target/playground/wallets`, funded by cheatcodes. They hold
nothing on a real cluster.

## What it shows

- The registry: each organization's interfaces, and the implementations behind each one. A switch
  shows unapproved implementations.
- The interface page: the display template as the title, the inputs as a form, the postconditions
  as guarantees, and each implementation with whether its `applies` checks hold.
- Intent: the intent JSON and the `prepare` request as curl, TypeScript, and Rust.
- Plan: the message, each instruction with its part of the segment, the compute units, and the RPC
  calls that the service made. `Verify` runs the service's verifier, and `Send` lands the
  transaction.
- Record: the selected implementation, its versions, and its document as the registry holds it.

"Tamper with the plan" makes the service change one byte of a built instruction. The verifier still
renders the plan's message, because it reads only `verify_intent`, and `verify_intent` refuses the
transaction onchain.

The Ondo records route through the Jupiter wrapper, at tier 2. Their side panel has a switch that
makes the wrapper also approve an attacker, which the segment's assertions refuse. The test
provider's record returns a transaction that the provider signed, at tier 3. Turn both onchain
checks off to accept it. Hastra's records show the request interfaces, which settle later.

A builder cannot name its rent payer as one of its own accounts yet, so a wallet that deposits into
a vault cannot also pay the fee. The playground defaults the fee payer to `alice` for that reason.
