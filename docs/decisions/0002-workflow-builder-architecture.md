# ADR 0002: Workflow Builder architecture

- **Status:** Proposed
- **Date:** 2026-07-30
- **Deciders:** Issuance team
- **PRD:** [Issuance Asset PRD [Draft]](https://app.notion.com/p/solanafoundation/Issuance-Asset-PRD-Draft-379d36dad52d81e684ffd3634ba81486) — Phase 5, Workflow Builder
- **Related:** [ADR 0001](0001-asset-profile-data-model.md); migrations `0048_asset_workflows.sql`, `0049_workflow_executions.sql`, `0050_notifications.sql`, `0055_kyc_wallet_status_changed_at.sql`, `0056_workflow_action_secret_retirements.sql`; catalog in `packages/sdp-issuance/src/workflows/`; engine in `apps/sdp-api/src/services/workflows/`
- **Diagrams:** [system map](0002-workflow-builder-architecture.svg) — components + data flow (for readers who know the codebase) · [walkthrough](0002-workflow-builder-walkthrough.svg) — plain-language, step-by-step tour with a running example (for newcomers to this area)

## Context

Asset Profiles (ADR 0001) give an issued token an identity and a lifecycle, but every
lifecycle action — allowlist a verified holder, freeze a sanctioned wallet, pause on an
incident, notify a team — is a **manual** dashboard click. The Phase 5 PRD asks for
**issuer-defined automation**: declarative rules of the shape

> **WHEN** something happens **→ THEN** do an action **(GUARD:** only if a filter passes**)**

that react to events SDP already processes (KYC decisions from provider webhooks, ramp
settlements, recurring-payment failures, completed token operations).

The canonical flow is *"WHEN a holder's KYC is approved → THEN add them to the token's
allowlist"*, but the same primitive must also drive irreversible on-chain operations
(mint, burn, seize, force-burn) and pure side effects (webhooks, notifications).

We need an engine that:

- reacts to internal events without coupling each event *source* to workflow internals,
- is **crash-safe and idempotent** — a redelivered provider webhook must not double-mint,
- can execute **irreversible on-chain operations** without becoming a way to bypass the
  authorization, policy, and safety checks the manual token routes already enforce,
- keeps *who may hold an asset* (**eligibility**) on a code path **upstream** of the
  builder, so a rule's guard can never weaken it,
- lets us add new triggers/actions **without migrations** (matching the ADR 0001
  "registry in code, open TEXT in the DB" precedent),
- reuses the existing on-chain service layer rather than reimplementing token operations,
- and gives the issuer a builder that shows the *exact* runtime pipeline a rule will take.

Everything ships behind the existing **asset-profiles feature flag** — no new flag.

## Decision

### 1. Three-stage rule model: WHEN → THEN → GUARD, stored as one row + JSONB

A rule is a single `asset_workflows` row scoped to `(organization_id, project_id,
token_id)` with `trigger_type` and `action_type` as top-level columns and everything else
— the guard condition, action params, retry policy, and any secret handle — inside a
`definition JSONB` column (`0048_asset_workflows.sql`). The domain shapes live in
`@sdp/types` (`WorkflowRule`, `WorkflowCondition`, `WorkflowAction`).

- **WHEN** = `trigger_type` (a catalog trigger).
- **THEN** = `action_type` + `definition.action.params` (amount, destination, webhook
  URL, notify audience, …).
- **GUARD** = `definition.condition`, a flat **AND of scalar comparisons** over the event
  payload (`{ all: [{ field, op: eq|neq|in, value }] }`). Deliberately not a general
  expression language — guards are operational filters ("only if provider is mural"), and
  a flat AND is enough while staying trivially serializable and safe to evaluate. Guards
  are also deliberately **not** where holder *eligibility* lives (§3): a rule author can
  add or remove a guard, so the guard leg carries only operational filters — never
  legally load-bearing eligibility.

Top-level columns are what the dispatcher filters on (hot path); the flexible,
per-action-shaped remainder is JSONB — the same split ADR 0001 used for
`issuance_metadata`.

### 2. The trigger/action catalog is code, not a table

`trigger_type` and `action_type` are open `TEXT` with **no CHECK constraint**. The
registry of what exists — the six triggers, the thirteen executable actions, each action's
execution tier, its capability requirement, and each trigger's guardable fields — lives in
`packages/sdp-issuance/src/workflows/` (`triggers.ts`, `actions.ts`), mirroring the Asset
Type Registry decision in ADR 0001 §2. Adding a trigger or action is a code change with no
migration; the app layer validates the request body against `WORKFLOW_TRIGGER_TYPES` /
`WORKFLOW_ACTION_TYPES` (enum membership, so prototype keys like `"toString"` can't slip
through). The package is Mosaic-free (only `@sdp/types` + the settings catalog), so the
API, the web app, and tests all import the same source of truth.

### 3. Emission: holder eligibility is gated upstream; the event bus only enqueues

Every trigger *source* — the Mural KYC webhook today, native KYC or external API webhooks
later — normalizes its occurrence into a single `WorkflowEvent` (`{ type, orgId,
projectId, eventKey, tokenId?, payload }`) and hands it to `dispatchWorkflowEvent`
(`event-bus.ts`). Sources never touch workflow internals. The bus:

1. loads enabled rules for `(project, trigger_type)` — token-scoped events additionally
   filter to that asset's rules, in SQL;
2. evaluates each rule's guard against the event payload;
3. inserts **one durable `workflow_executions` row per match** — and stops.

The bus **never runs actions.** This decouples the (latency-sensitive, fire-and-forget)
event path from the (retryable, side-effecting) execution path: a slow mint can never
delay a webhook response, and an action failure can never lose the event.

**Eligibility is decided upstream of the bus, not in a guard.** For the canonical KYC flow,
whether a holder is *cleared to hold an asset* is evaluated at the emit boundary
(`clearance.ts` — `evaluateHolderClearance` / `emitKycApprovedForClearedEnrollments`): a
`kyc_approved` event is dispatched **only** for cleared `(wallet, token)` pairs. In v1
"cleared" = identity verified **and** an active enrollment for that asset; the enrollment
deliberately *stands in* for full eligibility. This split matters because eligibility is
legally load-bearing while a guard is issuer-editable: keeping the eligibility decision on
a code path upstream of the builder means no rule author can widen who receives an
automated `allowlist_add` (or any action) by loosening a guard. The consequence for
evolution is that adding concrete **jurisdiction / accreditation / sanctions** checks is a
change to the single `evaluateHolderClearance` predicate — no engine, catalog, or schema
change — and every rule downstream tightens automatically.

### 4. A durable execution ledger that is also the retry state machine and the log

`workflow_executions` (`0049_workflow_executions.sql`) is written **before any side effect
runs**. One table serves three jobs at once:

- **crash-safety** — the intent is persisted; if the worker dies, the row survives;
- **retry state** — `status`, `attempt_count`, `max_attempts`, `next_attempt_at`,
  `locked_at` form a small state machine
  (`awaiting_review → pending → processing → succeeded | failed | cancelled`);
- **the execution log** — the dashboard's per-asset activity feed reads this table
  directly (indexed by `(org, project, token, created_at DESC)`).

This is the same pattern as the recurring-payment collection-attempts table (0017), reused
rather than reinvented.

### 5. Idempotency via a unique key, so redelivered events are no-ops

Each execution carries `idempotency_key`, derived from the rule plus the real-world event
identity (e.g. `kyc_approved:<walletId>:<tokenId>`), under a unique index on
`(workflow_id, idempotency_key)`. Enqueue is `INSERT … ON CONFLICT DO NOTHING`, so a
provider redelivering the same webhook — or two racing write paths both observing the same
KYC transition — produce exactly one execution. This is the primary defense against
double-minting/double-seizing at the *event* layer; §7 adds the defense at the *run* layer.

### 6. A cron engine with guarded claims, bounded concurrency, and backoff

A once-a-minute cron (`runDueWorkflowExecutions`, itself flag-gated in the cron runner)
drains due rows, modeled on the recurring-payments collection job:

- **Guarded claim** — `UPDATE … SET status='processing' WHERE id=? AND status='pending'`
  returns rows-affected; only one worker wins a row, so two ticks can't double-process.
- **Bounded parallelism** — a small worker pool (`CONCURRENCY = 5`) over a `BATCH_SIZE` of
  25 independent rows, so one webhook-heavy batch can't push the tick past the next fire.
- **Stale-lock recovery** — `processing` rows older than `STALE_AFTER_MS` are reset to
  `pending` (a prior tick died mid-flight) — **except** approval-gated actions, which park
  as `failed` for a human, because their side effect may already have landed.
- **Exponential backoff with jitter** — retry delay is `retryAfterMinutes × 2^(n-1)` (±20%,
  capped), the jitter keeping a fleet of failures from retrying in lockstep.
- **Per-tick caches** — a batch usually holds many executions of the same few rules on the
  same few tokens; each rule and gate context is loaded once per tick, not once per row.

### 7. Execution-time revalidation: the rule is re-checked against live state before it runs

The world can change between *enqueue* and *run* — the rule may have been disabled or
deleted, or the capability that unlocks its action revoked. So immediately after claiming a
row, `guardExecution` re-loads the rule and re-runs the capability gate (§8); a missing /
disabled rule or revoked capability fails the execution **permanently** with a clear reason
(`RULE_NOT_FOUND` / `RULE_DISABLED` / `CAPABILITY_REVOKED:<reason>`) rather than executing
stale intent. This is also the single place the rule's static action params, its secret
handle, and its retry pacing are loaded and threaded to the handler — the execution row
deliberately stores the *event* payload, not the rule's configuration, so config edits
always take effect on the next run.

### 8. One capability gate, pure, used at both save time and run time

`validateActionSupported` (`resolver.ts`) answers "can *this asset* perform *this action*?"
from the asset's category/type, enabled advanced settings, allowlist presence, and
mintability. It is pure and DB-free, and each action declares its requirement in the
catalog as a tagged `WorkflowActionRequirement`:

- `none` — pure side effect (webhook, notify, record);
- `allowlist` — needs the token to have an allowlist;
- `token_transaction` — needs an advanced setting to unlock a Token-2022 op (freeze, seize…);
- `base` — a base op (mint/burn) whose finer runtime checks happen at execution time.

The same function runs at **save time** (reject/preview an unsupported rule) and at **run
time** (§7). This is the reason the builder's preview and the engine can never disagree
about whether an action is available.

### 9. Three execution tiers drive review policy, retry policy, and authorization

Every action declares an `execution` tier, and the tier — not a per-rule flag — is the
source of truth for how dangerous it is:

| Tier | Actions | Review | Retry on failure | Write authz |
|------|---------|--------|------------------|-------------|
| `automated` | allowlist add/remove, webhook, notify, record | auto-applies | retryable w/ backoff | `tokens:write` |
| `sensitive` | pause/unpause, freeze/unfreeze | defaults to manual | retryable w/ backoff | `tokens:admin` |
| `requires_approval` | mint, burn, seize, force_burn | **always** held | **single-shot** (never auto-re-dispatched) | `tokens:admin` |

- **Review:** `requires_approval` rules are forced to `awaiting_review` at enqueue
  regardless of the stored review mode; a human approves via a deliberate **hold-to-confirm**
  control, and `decided_by` / `decided_at` record who. The API also **refuses to store**
  `reviewMode: "auto"` for the tier, on create and on edit, so the stored row cannot claim a
  destructive rule fires unattended — the builder renders `review_mode`, so a row that
  disagreed with the engine was a lie told to an operator.
- **Retry:** an approval-gated action that fails is *single-shot* — each run was explicitly
  authorized by a person, so a failure must return to a person, never re-enter the
  automatic retry loop.
- **Authorization (§10)** keys off the same tier.

### 10. Workflows must not be a privilege-escalation path

The direct token routes already gate irreversible ops on `tokens:admin` (seize, force-burn,
pause, freeze). If workflow rules were uniformly `tokens:write`, a member could do
indirectly what they can't do directly. So workflow create/update/approve/reject are gated
by a **tier-derived permission** (`workflow-authz.ts`): `automated` needs `tokens:write`,
`sensitive` and `requires_approval` need `tokens:admin`. For update/approve/reject the tier
comes from the *stored* rule's action, not the request body. The API is the source of
truth; the UI gate is defense-in-depth.

### 11. Action handlers reuse the existing operation layer — they are callers, not a second implementation

Each executable action is a thin handler under `services/workflows/actions/` that builds
the **same** env-based services the HTTP handlers use (`createOrgSigner` →
`MosaicService` / `Token2022Service`) and, critically, runs the **same preflight** the
manual path runs (`preflight.ts`): wallet-operation policy, control-list destination
checks, and supply/`maxSupply` validation **before** touching the chain. The workflow
engine is a new *caller* of existing, already-audited token operations — not a parallel
code path that could drift from their safety rules. On-chain outcomes flip to a permanent,
human-reviewable failure rather than blind-retrying a possibly-already-applied transaction.

Two of those gates need to hold under concurrency, so preflight alone does not decide them:

- **The supply cap is enforced by an atomic reservation, not by the preflight.** The
  preflight reads the supply snapshot loaded when the action was prepared, so two mints
  running at once (rule + rule, or rule + HTTP) both pass it and both land above
  `maxSupply`. The binding check is `reserveMintSupply` — a conditional `UPDATE`
  contending on the token row — run from `mintTo`'s pre-submit hook exactly as the HTTP
  execute route runs it. The preflight remains as an early, cheap rejection. The
  reservation **is** the count: nothing is added when the mint settles, and nothing is
  handed back on an ambiguous post-submit failure, because a transaction that may still
  land must not release headroom a second mint could take.
- **Wallet-operation policy binds the wallet that actually signs**, which is not always the
  token's nominal `signingWalletId` — an authority fallback can settle on a different
  custody wallet, and a token naming no wallet still signs with the org default signer's.
  All four destructive actions (mint, burn, force_burn, seize) submit their operation for
  enforcement; a denial is a deliberate "no" and therefore permanent.

### 12. Secrets are handled out-of-band, never in the rule JSONB

A `send_webhook` rule can carry an HMAC signing secret. It is stored via the existing
`credential-secret-store`, referenced from the definition by handle, and **redacted from
every read response** — the engine resolves the real value only at dispatch. Outbound
webhook URLs are validated at save time and re-checked at run time against SSRF
(`webhook-url.ts`: https-only, private/link-local/metadata hosts rejected, redirects not
followed).

A secret's **retirement is as much a part of the contract as its storage**: a rotation
supersedes a version, a delete orphans one, and a rejected insert leaves one referenced by
nothing. Each of those destroys the version so it does not stay readable in the backend.
Two properties make that safe:

- **The write is atomic with respect to its own failure path.** A rule write is a single
  statement (`UPDATE … RETURNING *`), so a rejection genuinely means nothing committed and
  the version the edit installed can be retired. A write followed by a separate read could
  fail *after* committing, and retiring then would destroy the credential the live rule now
  points at — signing every later delivery with a dead key.
- **A failed destroy becomes durable work, not a log line.** Retirement always runs after a
  write that already committed, so it can never fail the request. A backend error — or a
  credential store this process cannot even construct, which is unreachable rather than
  absent — is queued in `workflow_action_secret_retirements` (`0056`) keyed on the version
  ref. A **dedicated cron task behind no feature flag** drains it with capped exponential
  backoff, never abandoning a row. The drain deliberately does not ride on the workflow
  tick: that tick is gated on asset profiles, and the queue only ever holds credentials
  that are already orphaned, so turning the feature off would strand its cleanup
  permanently — precisely when disabling the feature is the incident response. Deleting
  a rule is likewise idempotent over its own partial failure — the delete handler reads
  soft-deleted rows, so a retry finishes cleanup a first attempt died in the middle of.
  The table carries **no foreign keys on purpose**: the work must outlive the rule, project
  and organization it came from, since the point of a retirement is that nothing references
  the credential any more.

### 13. Notifications are a durable, per-user store the `notify` action writes into

`notifications` (`0050_notifications.sql`) is a per-user inbox powering the dashboard bell.
The workflow `notify` action is its first producer; other producers plug in later. Rows
carry structured `params JSONB` for localized client rendering with a server-composed
`title`/`body` fallback, and a producer idempotency handle so retries don't duplicate.
Whether email is configured is exposed to the client as a **single boolean** — never the
provider name or env-var names. Per-user delivery preferences and multi-channel dispatch
are an explicit deferred follow-up.

### 14. Rules soft-delete; execution history is immutable

Deleting a rule sets `deleted_at`; it disappears from every read path but its
`workflow_executions` history is retained. A hard delete would cascade and erase the run
log the ledger exists to provide.

### 15. The builder is two surfaces: controls + a live execution preview

The dashboard Workflows tab is split into **controls** (When / Then / Review selectors +
per-action param inputs + the "only if…" guard editor) and a **live execution preview** —
a read-only pipeline, computed entirely client-side from the same catalog, that renders the
exact runtime path a rule will take: *trigger → guards → the automatic capability gate →
the review gate → the action*, each with a status dot. This surfaces the otherwise-invisible
capability gate as a real step, so the issuer sees why an action is (un)available before
saving. The creation wizard reuses the same catalog for its "automations you'll unlock"
preview. The web app talks to sdp-api through Next BFF proxy routes; i18n keys are keyed by
the trigger/action type itself, so the catalog and the message files can't drift apart.

## Alternatives considered

- **Run actions inline in the event handler** (no ledger, no cron). Simplest, but loses
  crash-safety, idempotency, retries, and the execution log, and couples provider webhook
  latency to on-chain execution. Rejected — the durable ledger is the whole point.
- **A general expression language for guards.** More expressive, but a much larger safety
  and validation surface for a builder whose real need is "filter by a payload field." A
  flat AND of scalar comparisons is enough and trivially safe. Rejected for v1.
- **A dedicated `workflow_tasks` approval subsystem** with assignees and due dates.
  Overkill for v1; the built-in `awaiting_review` state + hold-to-confirm already provides
  the human gate. Deferred (a documented follow-up).
- **Reimplement the on-chain operations inside the engine** for a "cleaner" action layer.
  This is exactly the drift/authorization-bypass risk §11 exists to prevent. Rejected — the
  handlers call the existing operation + preflight layer.
- **A managed outbound-webhook registry** (endpoints, rotation, delivery log). The right
  long-term home for webhook secrets and delivery history, but far larger than Phase 5.
  Deferred; the MVP carries a URL + a secret handle on the rule.
- **A CHECK constraint / lookup tables for trigger & action types.** The DB-managed
  configuration product ADR 0001 already put out of scope. Rejected; the catalog is code.

## Consequences

- New triggers/actions ship without migrations — only `@sdp/issuance/workflows` and its
  i18n keys change.
- The event bus and the executor are independently scalable and independently testable; a
  new trigger source only needs to emit a `WorkflowEvent`.
- Idempotency (§5) + guarded claims + single-shot approval actions (§6, §9) make
  double-execution of an irreversible on-chain op structurally hard at three layers.
- Because handlers reuse the operation + preflight layer (§11), a change to a token-op
  safety rule automatically applies to the workflow path — but a handler that forgets to
  call preflight would silently bypass it, so preflight coverage is a standing test
  requirement.
- The execution ledger is the audit and debugging surface: a guard that never matches, a
  revoked capability, a parked stale row, and a rejected approval are all inspectable rows.
- The capability gate being pure and shared (§8) means the builder preview is a faithful
  predictor of runtime behavior, not a separate approximation.
- Eligibility (who may hold the asset) is gated at emission (§3), so the guard leg stays
  purely operational: a rule author can never relax eligibility with a guard edit, and
  tightening eligibility later is a change to `evaluateHolderClearance` alone. The trade-off
  is that eligibility is *invisible in the builder* — it is not a rule the issuer sees or
  configures — so it must be documented where issuers reason about "who gets allowlisted".
- Feature-flag gating spans the routes, the emitters, **and** the cron together, so a
  flag-off deployment can neither accept rules nor accumulate an undrained backlog.

## Follow-ups (tracked, not decided here)

- **Concrete holder-eligibility checks** (jurisdiction, accreditation, sanctions) added to
  `evaluateHolderClearance`. v1 uses "identity verified + active enrollment" as the stand-in
  for eligibility (§3); the fast-follow tightens that one clearance predicate, with no
  engine, catalog, or schema change, and every downstream rule inherits it.
- Full outbound-webhook registry (endpoint CRUD, secret rotation, delivery log, redeliver).
- Full notification center: per-user channel/category preferences, a dispatch/fan-out
  service, and wiring producers beyond the `notify` action.
- A dedicated `workflow_tasks` approval system (assignees, due dates), which would re-add a
  `create_approval_task` action and an `approval_decided` trigger.
- Investor-reporting generation + cadence scheduler + a holder→email data source, for which
  the notification/email layer is the delivery last mile.
- Re-evaluating the guard's guardable-field set as more trigger payloads gain structured,
  filterable fields.
