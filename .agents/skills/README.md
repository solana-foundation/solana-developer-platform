# Ramp-provider integration skills

Agent skills for a payment provider contributing its own fiat↔crypto ramp integration to SDP. Provider adapters live in `packages/sdp-payments`; API orchestration, persistence, availability, and webhooks live in `apps/sdp-api`; shared public response types live in `packages/sdp-types`.

## Who this is for

**Partners and payment providers** who want to plug into SDP's ramps. Fork the repo, run the coding agent from the repo root, and use these skills to prepare the contribution.

Before coding, complete the [ramp intake](https://solanafoundation.typeform.com/to/sxTGbwXt) and read the [public provider-onboarding guide](../../apps/sdp-docs/content/docs/reference/provider-onboarding.mdx). Maintainers need provider docs, sandbox credentials, supported Solana rails, rate limits, webhook setup, and known sandbox limitations to validate the PR.

## How agents pick them up

The canonical home is `.agents/skills/`. These workflows are explicit-only: discover them in the agent's skill menu and invoke the one you want; their descriptions do not need to occupy normal task context.

- **Codex** reads `$CWD/.agents/skills` natively — run it from the repo root.
- **Claude Code** reads them via the `.claude/skills` → `.agents/skills` symlink.
- Other agents (e.g. Cline): point your rules at `.agents/skills/`.

## Where to start

Explicitly invoke **`integrate-ramp-provider`** first. Pass the provider docs URL and state the supported directions, quote delivery mode, sandbox environment, rail-discovery source, counterparty/KYC flow, and settlement mechanism. Then invoke only the capability skills the provider needs:

| Skill | Covers |
|---|---|
| `register-provider` | Step 1 — wire the provider id, package client, API schemas/dispatch, availability, setup registry, secrets, and dashboard catalog |
| `rail-discovery` | Declare supported fiat/crypto corridors and regenerate the support matrix |
| `integrate-estimate` | Rate preview (`estimateOnramp` / `estimateOfframp`) |
| `counterparty-requirements` | Required readiness contract (`ready`, `unsupported`, KYC, or payout requirements) |
| `integrate-onramp` | Fiat→crypto quote |
| `integrate-offramp` | Crypto→fiat quote |
| `integrate-webhook` | Signature verification + settlement events |

Capability work is parallel after registration. For an unsupported direction, declare empty support and implement the required interface methods as typed rejections; only `createOnrampQuote` is optional in the current `RampProvider` contract.

## Choose the closest reference

| Integration shape | Reference |
|---|---|
| Manual instructions + counterparty provisioning | `packages/sdp-payments/src/ramps/providers/lightspark/client.ts` |
| Hosted redirect/widget | `packages/sdp-payments/src/ramps/providers/moonpay/client.ts` |
| Embedded session widget | `packages/sdp-payments/src/ramps/providers/stripe/client.ts` |
| Multi-step KYC, accounts, and provider-specific DB state | BVNK or Mural package client plus `apps/sdp-api/src/routes/payments/handlers/ramps/<provider>.ts` |

The type system catches many missing registrations, but not every schema, public type, translation, or UI catalog. Use `register-provider` as the complete checklist.
