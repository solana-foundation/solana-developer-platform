# Private Earn spike

A spike to prove that private funds in Solana Privacy Rings can go into an Earn protocol and come
back out, through a ring program of SDP's. It is the least proven part of `DESIGN.md`, 4.17 ("SDP's
ring program", design only). The spike answers whether that design is feasible. It does not build
the design.

## Questions

The spike answers four questions, each with a test and a measurement.

1. **Authorization.** Can a third-party ring program spend an owner's notes only for the action
   that the owner signed? The pool binds the spend to the ring program's data through
   `ring_data_hash`.
2. **Composition.** In one transaction, can the program spend the notes to its own token account,
   deposit into Kamino as its PDA, and keep the shares?
3. **Limits.** Does that transaction fit 1,232 bytes with an address lookup table, and the
   1,400,000 compute unit budget? Measure both, for the deposit and for the withdrawal.
4. **The way back.** Can the program redeem the shares and pay the USDC into a new note of the same
   owner, in one transaction?

A "no" to any question is a result. Record why, and stop.

## Step 1: read the source

Read before writing any code, and write down the answers in this file under "Findings". The Privacy
Rings source is the fork at `~/source/zolana`, at the commit that `intents/crates/privacy-rings`
pins (`e97a1393`, Zolana `v0.6.0-alpha` with three dependency bumps).

| Question | Where to look |
| :-- | :-- |
| How a ring program registers and activates, and who may activate it | `programs/shielded-pool`, `xtask/src/update_protocol_config.rs` (`ring_activation_is_permissionless`), `xtask/src/init_protocol.rs` |
| What `ring_data_hash` covers, and what the owner's signature covers | `programs/shielded-pool`, `sdk-libs/transaction/src/data.rs` |
| How a ring program calls the pool (`ring_transact`), and whether a withdrawal can pay the program's own PDA | `programs/shielded-pool`, `sdk-libs/program/src/client/program_owner.rs` |
| An existing ring program to copy | `sdk-libs/program/tests/wasm/program` |
| The CPI depth: SDP program, then Kamino, then the token program, and SDP program, then the pool | The pool's own CPIs in `programs/shielded-pool` |
| Whether the surfnet deploy can activate a ring | `intents/programs/tools/deploy-surfnet.mjs`, `fetch-zolana.mjs`, `zolana-artifacts.json` |

## Step 2: build

One program and one test. No intents definitions, wallet driver, service, or playground changes.

**Program** `intents/programs/private-earn` (Anchor v2, like `intents/programs/registry`):

- `deposit { spend, kamino accounts }`: calls the pool's `ring_transact` with the owner's spend,
  which withdraws USDC to the program's token account. Then deposits that USDC into Kamino as the
  program's PDA. Then records the shares in a receipt account at a PDA of
  `SHA-256(owner secret ‖ salt)`, so the owner's address is not written in the clear.
- `withdraw { proof of the salt, spend, kamino accounts }`: redeems the receipt's shares from
  Kamino to the program's token account, then calls the pool to deposit that USDC into a new note of
  the owner. Closes the receipt.
- The program accepts a spend only when its `ring_data_hash` equals the hash of the action, its
  arguments, and its accounts.

**Test** on the surfnet that `just e2e` starts, with Privacy Rings and Kamino as the e2e places
them:

1. Shield USDC for an owner, with the existing driver in `intents/crates/privacy-rings`.
2. Deposit privately. Assert that the receipt holds the shares and that the owner's notes dropped by
   the amount.
3. Withdraw privately. Assert that the owner holds a new note of at least the amount, less Kamino's
   rounding.
4. Print the transaction size and the compute units of steps 2 and 3.
5. Show that a spend whose `ring_data_hash` names another action fails.

## Out of scope

- Intents integration: a `shielded` implementation whose program is the ring program (4.17), and
  the wallet driver's support for `ring_transact`.
- The generic action envelope, `inner` actions, and `check_intent`.
- The share buffer that returns shares directly into a note.
- Anonymity. The `ConfidentialSigner` rail that the prototype uses makes the owner's signature
  visible. Hiding the owner needs the relayer rail.
- Mainnet ring activation, which needs Helius's protocol governance unless the ring is
  permissionless.
- The security of one program that holds every owner's shares.

## Context

- Code: branch `prototype/intents`. Rust crates in `intents/crates`, programs in
  `intents/programs` (a separate workspace), e2e in `intents/e2e`.
- Builds: `cargo build-sbf` needs `PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`.
  The registry tests load `programs/target/deploy/*.so`, so rebuild after a program change.
- The e2e starts surfpool, deploys the programs, starts Photon and the prover, and runs
  `e2e/run.mjs`. Its Kamino flow (`kamino-deposit`) shows the Kamino accounts that a deposit
  needs.
- Repository rules: `AGENTS.md`, and the code standards that it names. Production Rust has no
  `unwrap`, `expect`, or `panic!`. Commits are signed. Committed text is in Simplified Technical
  English.

## Findings

(Step 1 fills this section in.)
