# Ramp-provider integration skills

A set of **agent skills** that walk an engineer through integrating a new fiat↔crypto on/off-ramp provider into the Solana Developer Platform (`apps/sdp-api`).

## Who this is for

**Partners and payment providers** who want to plug into SDP's ramps. Fork the repo, open it in your coding agent, and these skills guide the integration PR end to end — in SDP's architecture and conventions, so it compiles, follows the house rules, and reviews fast.

## How agents pick them up

The canonical home is `.agents/skills/`. These workflows are explicit-only: discover them in the agent's skill menu and invoke the one you want; their descriptions do not need to occupy normal task context.

- **Codex** reads `$CWD/.agents/skills` natively — run it from the repo root.
- **Claude Code** reads them via the `.claude/skills` → `.agents/skills` symlink.
- Other agents (e.g. Cline): point your rules at `.agents/skills/`.

## Where to start

Explicitly invoke **`integrate-ramp-provider`** first — the umbrella that sequences the work and lists the non-negotiable rules (no fallbacks, HTTP in the provider / DB in the handler, fully typed webhooks, env-var secrets). Pass it a **`docs`** parameter pointing at your provider's API documentation (e.g. `docs: https://docs.yourprovider.com`) so each step maps your endpoints accurately. Then work the steps:

| Skill | Covers |
|---|---|
| `register-provider` | Step 1 — wire the provider id, client registry, dispatch switches, availability, and secrets. "Add the id, follow `tsc`." |
| `rail-discovery` | Declare supported fiat/crypto corridors and regenerate the support matrix |
| `integrate-estimate` | Rate preview (`estimateOnramp` / `estimateOfframp`) |
| `counterparty-requirements` | KYC / payout requirements (`validateCounterparty`) |
| `integrate-onramp` | Fiat→crypto quote |
| `integrate-offramp` | Crypto→fiat quote |
| `integrate-webhook` | Signature verification + settlement events |

Skip the flows you don't support — they're parallel capabilities, not a strict pipeline.

## Reference implementation

`apps/sdp-api/src/lib/ramps/providers/lightspark/client.ts` is the canonical example the skills point at. The type system is the checklist: adding your provider id to `RAMP_PROVIDERS` breaks compilation at every site you must wire.
