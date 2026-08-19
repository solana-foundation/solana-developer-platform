# PII and credential scrubbing policy

The platform stores regulated personal data: counterparty identities (`firstName`,
`lastName`, `dateOfBirth`, `phone`, postal address), contact email, and bank instruments
(`accountNumber`, `routingNumber`, `iban`). At rest these live inside an envelope managed by
`apps/sdp-api/src/services/pii-cipher/pii-cipher.ts`. Anything that reaches an error message,
a log line, a Sentry event, or an audit row has left that envelope. This document is the
policy for those boundaries and the review of the configuration around them.

The denylist and the scrubbers are one module: `packages/sdp-redaction` (`@sdp/redaction`),
imported by the API, the dashboard, and the packages that talk to providers. There is no
second copy to drift.

## The two passes

| Pass | Function | Applied to |
| --- | --- | --- |
| Credential only | `redactCredentialString`, `redactCredentialSecrets` | Client-facing error bodies |
| Credentials + PII | `scrubTelemetry`, `scrubTelemetryString`, `scrubError` | Logs, Sentry, traces, metrics |
| Credentials + PII, emails masked | `scrubAuditMetadata` | Audit ledger `metadata` |

A 4xx response goes back to the tenant that submitted the data in it. Stripping its own
counterparty fields out of a validation error would remove the only thing that makes the
error actionable, so the response path stays on the credential-only pass. PII scrubbing is
for the sinks *we* read.

Audit metadata masks (`j***@example.com`) rather than drops: an invitation event whose
subject is unnamed is not an audit trail. The full address stays in the invitations table
behind tenant scoping, and the domain — usually the question a reviewer is actually asking —
survives.

Masking is by value shape as well as by key, so it reaches addresses that arrive under a
non-obvious key. The signup allowlist is the case to know about: `routes/allowlist/handlers.ts`
audits `metadata: parsed.data`, where the address sits under `value`, so an `email` entry
persists as `j***@example.com` while a `domain` entry (`hoodies.team`) stays fully readable.
Either way the `allowlist` table holds the exact value and the audit row's `resourceId`
resolves to it.

## What is never redacted

These are not oversights. Each is load-bearing, and a future rule that starts matching one
of them is a regression:

- **Solana addresses** — `address`, `walletAddress`, `destinationAddress`, `mintAddress`.
  Public on-chain, pseudonymous, and the primary handle for tracing a payment. This is also
  why the policy is an explicit key denylist rather than an entropy or shape heuristic:
  every base58 public key would trip a "this looks secret" detector.
- **Resource ids** — every `*Id`. The join key between a log line, an audit row, and a
  Sentry issue.
- **`countryCode`, `subdivisionCode`, `currencyCode`** — needed to tell a provider outage
  from an unsupported corridor, and not identifying once the name, phone, date of birth,
  and street are gone.
- **`details`** — `AppError.details` carries validation output. Its PII-bearing children
  (`accountNumber`, `line1`, …) are matched individually instead.
- **`userAgent`** — not identifying on its own, and how client-specific bugs get diagnosed.
  The audit table stores it in a dedicated column by design.
- **`name`** — provider names, wallet labels, rule names, token names. The person-shaped
  variants (`firstName`, `fullName`, `accountHolderName`, `displayName`) are matched
  explicitly.

Postal addresses are defused component by component (`line1`, `city`, `postalCode`) rather
than by their container key, precisely because that container key is `address`.

That has a consequence worth stating plainly, because it is the most likely way this policy
develops a hole: **every provider spelling of the street line has to be listed by name.**
Today that means SDP's own `line1`/`line2` (`CounterpartyAddress`), BVNK's
`addressLine1`/`addressLine2` (`BvnkRuleEntityAddress`), and Mural's `address1` inside
`physicalAddress` (`MuralPhysicalAddress`). A blanket `*Address` suffix rule is not available
as a shortcut: BVNK's `beneficiaryAddress` carries `destinationWalletAddress`, a crypto
address. Adding a ramp provider means checking its address shape against
`PII_KEYS` in `packages/sdp-redaction/src/policy.ts`.

## The sinks

Every boundary below is enforced in code, not by asking call sites to remember. A new sink
is not done until it appears here with a test.

| Sink | Enforcement point |
| --- | --- |
| API logs (pino) | `hooks.logMethod` in `apps/sdp-api/src/runtime/logger.ts` — every argument, including the message |
| API Sentry: errors, transactions, spans, logs, metrics, breadcrumbs | `sentryScrubbingHooks` spread into `getSentryOptions` (`apps/sdp-api/src/runtime/observability.ts`) |
| API Sentry capture payload | `scrubError` in `captureUnexpectedError` (`apps/sdp-api/src/app.ts`) |
| Audit ledger metadata | `scrubAuditMetadata` in `AuditService.persist` — before the row is hashed |
| Dashboard Sentry (browser, server, edge) | `sentryScrubbingHooks` spread into all three `Sentry.init` sites |
| Dashboard Sentry user | `apps/sdp-web/src/components/sentry-user-context.tsx` — Clerk user id only |
| Ramp provider error messages | `extractProviderErrorMessage` (`packages/sdp-payments/src/ramps/fetch.ts`) |
| Fireblocks request/response tracing | `scrubTelemetry` in `keychain-fireblocks.adapter.ts` (writes via `console`, bypassing pino) |

Scrubbing failure is a drop, not a pass-through: if the walker throws inside a Sentry hook
the payload is discarded and `sdp_telemetry_scrub_failed` is written to stderr. An
unscrubbed event is an incident; a missing event is a gap in a dashboard.

Two details of the walker exist because it is now on an attacker-reachable path — a provider
webhook body passes through it before anything else reads the payload:

- **Depth is bounded** at 16 levels, beyond which the subtree becomes `[Truncated]`. The
  cycle guard alone would not stop a deeply nested body from overflowing the stack inside a
  log call.
- **Key normalization strips separators**, so `x-api-key`, `X-Api-Key`, and `apiKey` are one
  rule. The header form is what arrives as a Sentry `request.headers` entry, and an
  exact-match-only rule would have missed it.

## Configuration review

### Sampling

| Setting | Value |
| --- | --- |
| `tracesSampleRate` (API) | 0.1 in production, 1 otherwise; overridable via `SENTRY_TRACES_SAMPLE_RATE`, clamped to `[0, 1]` |
| `tracesSampleRate` (web) | 0.1 in production, 1 otherwise |
| `replaysSessionSampleRate` | 0.1 |
| `replaysOnErrorSampleRate` | 1.0 |
| `enableLogs` (web) | true — structured logs go to Sentry and are covered by `beforeSendLog` |

Sampling bounds the cost of scrubbing as well as the volume: span and transaction payloads
are walked only for the traces that are actually sampled.

### Runtime access and retention

- **Sentry** — retention and project membership are configured in the Sentry organization,
  not in this repo. Both are outside version control and need periodic review; the checklist
  below is the part that must hold for this policy to mean anything in production.
- **Cloud Logging** — the API's pino stream lands in Google Cloud Logging under the Cloud
  Run service. Retention is the bucket's configured period; access is IAM on the project.
- **Audit ledger** — retention is indefinite by design and age never authorizes deletion;
  see `docs/ops/audit-ledger.md`. This is why metadata scrubbing happens *before* the row is
  hashed: what the chain commits to is exactly what a reviewer can read back, forever.

### Required Sentry console settings

These cannot be expressed in code. They are the second layer behind the hooks:

- [ ] Server-side data scrubbing enabled for both projects.
- [ ] "Prevent Storing of IP Addresses" enabled.
- [ ] Additional sensitive fields configured to mirror this denylist.
- [ ] Project access limited to the engineers who need it; reviewed alongside retention.

### Open risks

- **Feedback screenshots.** `enableScreenshot: true` on the feedback widget captures the
  rendered page, and `replayIntegration`'s `maskAllText` does **not** apply to screenshots.
  A user submitting feedback from a counterparty detail page sends that page to Sentry as an
  image, which no hook can scrub. Either disable screenshots or treat feedback attachments
  as PII-bearing and restrict access accordingly — a product decision, deliberately not made
  by the change that introduced this document.
- **No metrics emitter exists yet.** `beforeSendMetric` is wired ahead of need so the first
  one is born scrubbed.
- **Free-text PII that is neither keyed nor email-shaped.** A surname written into a prose
  log message survives. The mitigation is the key-based rules covering every structured
  path, plus the assignment patterns (`phone=`, `firstName:`) that catch the self-labelling
  cases; there is no shape-based detector for a name, and a guessing one would redact
  provider names and token symbols.
