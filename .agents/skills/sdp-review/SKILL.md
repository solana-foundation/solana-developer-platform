---
name: sdp-review
description: ADHD-friendly digest of a change set in the SDP repo — what changed product-wise, how it's technically implemented, which domains are touched, and which packages are used — plus a reuse/zod/transaction review pass and product-obligation checks (policy coverage, encryption, Kora budgets, metered quota). Use when explicitly invoked or when the user asks for a digestible summary of a diff, branch, or PR.
disable-model-invocation: true
---

Digest a change set into short, scannable bullets, then run a focused review pass (reuse, parsing, dependencies, transactions). Not a full correctness review — the `code-review` and `owasp` skills cover that.

## 1. Base style

Read [`../sdp-concise/SKILL.md`](../sdp-concise/SKILL.md) and apply its output contract. This file reference is the shared Claude/Codex source of truth; do not depend on an agent-specific output-style plugin.

## 2. Pin the change set

Default scope is the current working diff (`git diff` + `git diff --staged` + untracked files). If the user names a base (`--base <ref>`, a branch, a PR number via `gh pr diff`), diff against that instead. If the working tree is clean and no base was given, diff the current branch against `main`.

Read enough of the changed files (and their immediate callers) to describe the change accurately — never summarize from filenames alone.

## 3. Output

Four sections, bullets only, each bullet one line where possible. Plain language first, `code refs` second.

**Product changes** — what a user of the dashboard or API can now do / no longer do / sees differently. If a change is purely internal, say "no user-visible change" and one line why the work exists.

**How it's implemented** — the technical mechanism per product bullet: new/changed routes, DB migrations + tables, services, providers, UI components. Reference as `file:line`. Call out money-path mechanics (idempotency, transactions, policy gating) explicitly when present.

**Domains touched** — which SDP domains this crosses: issuance, ramps (per provider), payments/batches, custody wallets, counterparties/compliance, policy, auth/keys, webhooks, dashboard, docs. One bullet per domain with a half-line of what changed there.

**Packages used** — two lists:
- Workspace packages touched or consumed (`apps/sdp-api`, `apps/sdp-web`, `packages/sdp-types`, `@sdp/payments`, `@sdp/policy`, …) and what for.
- External dependencies newly added or leaned on in this change (from `package.json` diffs and new imports). No new deps → say so in one bullet.

Keep the whole digest under ~30 bullets. If the change set is bigger than that, group by domain and compress — digestibility beats completeness.

## 4. Review pass

After the digest, check the changed code against these rules. Findings only — a rule with no violation is skipped silently. Each finding: `file:line`, what's wrong, the concrete fix. All clean → one line: "Review pass clean."

- **No hand-rolling** — every new helper is checked against existing `utils`/shared modules, `@sdp/*` packages, and already-installed dependencies. Reimplemented common functions (money math, date/currency formatting, ID generation, retry/dedupe logic) are findings; name the existing helper to reuse. `@sdp/payments` decimal helpers are the only money math.
- **Parsing via zod** — all external input (route bodies/params/queries, webhook payloads, provider responses, env at startup) parsed with zod schemas at the boundary. Hand-rolled `typeof`/`in` narrowing, `JSON.parse` casts, or `as`-typed payloads are findings. Variant data → `z.discriminatedUnion` with `z.infer`, never a hand-written parallel type.
- **Package-first functions** — for every new non-trivial function, ask: does an already-installed package or stdlib implement this? If yes, use it. Adding a new dependency needs genuine justification; a few lines of code beat a new dependency.
- **Solana Kit ecosystem first** — for every changed Solana-facing type, helper, instruction, transaction, RPC operation, signer flow, or amount calculation:
  1. Check the APIs exported by the repository's pinned `@solana/kit`.
  2. Check official `@solana/*` packages already declared by the affected workspace.
  3. If the appropriate API exists only in a newer Kit release, report it as an upgrade candidate; do not silently add a dependency or rely on a transitive package.
  4. Keep an `@sdp/*` wrapper only when it adds SDP-specific behavior such as configured transports, retries, observability, tenant policy, provider normalization, persistence, idempotency, or atomic workflow boundaries.

  Prefer official branded types, constructors, codecs, fixed-point arithmetic, account helpers, instruction guards and plans, signer helpers, transaction lifetime and size checks, commitment comparison, confirmation strategies, and typed RPC methods.

  Flag hand-written commitment ordering, packet-size constants, decimal math, raw standard JSON-RPC payloads, Solana-specific Buffer/base64 conversion, signer-shaped object casts, and `as Address` / `as Signature` / `slot: bigint` where Kit provides the semantic type or validator.

  Compare against versions pinned in this repository, not APIs found only on Kit's `main` branch. Generic HTTP encoding, provider-specific protocols, and health probes are not automatically Kit concerns.
- **Trim the package list** — when `package.json` changed, scan the touched workspace's dependencies for entries no longer imported anywhere and propose removals. Also flag deps this change made redundant.
- **Pinned versions** — when package manifests or workspace catalogs change, require registry dependencies to use exact versions with no ranges or moving tags; validate them with `pnpm check:pinned-dependencies`. Preserve intentional non-registry references accepted by that check, including `workspace:*` and `catalog:`. When `.github/workflows/**` changes, require every external `uses:` reference to use a full 40-character commit SHA with the readable release tag in a trailing comment. Version tags, branches, and moving refs such as `@v2`, `@main`, or `@latest` are findings; local `./` actions are exempt.
- **Transactions are atomic: all or nothing** — treat each logical state transition as one atomic unit. Run every invariant read and related create/update/archive/audit/outbox write inside ONE `db.transaction`, pass the same `asTransactionalClient` through every callee, and never mix the transaction client with the root DB client. Any failure must escape so the transaction rolls back; catching a failed write and continuing is a finding. External provider or RPC calls cannot roll back with the database, so require an idempotent staged state or outbox boundary that cannot leave partial or duplicate state. Require a failure-path test proving that a mid-sequence failure rolls back every database write. Every query must remain scoped by the authenticated tenant or parent ID.
- **Silent defaults are a smell** — any expression that substitutes a default when data is missing or malformed: `?? {}`, `|| {}`, `?? []`, `.catch(() => ({}))`, `JSON.parse`-or-default wrappers, optional chaining on always-present data, default params papering over an absent argument. Each hides a failure that should surface — fail loudly, tighten the type, or parse at the boundary. A defaulted `{}` flowing into an all-optional schema or a spread is the worst case: it turns a dropped payload into a silent 200 no-op. Flag every instance; "restores previous behavior" is not a defense.
- **Anti-slop** — low-evidence typing and low-signal patterns in the changed code:
  - `unknown` leaking through contracts: `unknown` params (except `cause`), `unknown`/`Promise<unknown>` returns, type aliases resolving to `unknown`, dictionary value types of `unknown`/`any`/`object`/`{}`. Decode external input at the I/O boundary into a named domain type.
  - Assertion abuse: chained `as` assertions, widen-a-const-then-assert-it-narrower, any type assertion (other than `as const`) without a nearby SAFETY comment.
  - Runtime `typeof` narrowing of external values instead of parsing at the boundary; `Reflect.get`/`Reflect.apply`.
  - Conditional empty-object spreads (`...(cond ? { x } : {})`), function params typed as bare `object` instead of an owner-provided named type, the substring "shape" in any symbol name, module mocking in tests (`vi.mock`/`jest.mock`) instead of injecting through real interfaces.
- **React Doctor** — when the change set contains `.jsx` or `.tsx` source files, use the repository's installed version and run `pnpm exec react-doctor --verbose --scope changed --base <resolved-base-ref>`. Keep `scope` set to `changed`; never substitute a full-project scan or fetch a different version with `npx`. If the local binary is unavailable, ask whether the user wants to install an exact local version or rely on the existing changed-scope React Doctor CI check. Never install implicitly. If they choose CI, skip the local scan and report it as pending until the PR check completes. Fold introduced diagnostics into the review findings with the same `file:line` / problem / fix format. No changed React source files → skip this check silently.

## 5. Product checks

Platform obligations the change may trigger. These are active checks, not a questionnaire: when a check is triggered, cross-reference with the code — read the route wiring, the migration, the service — and verify the obligation is actually handled. A triggered obligation the change doesn't handle is a finding (`file:line`, what's missing, where the existing mechanism lives). Nothing triggered → skip the check silently; all quiet → one line: "No product obligations triggered."

- **Policy coverage** — when the change adds or alters an operation that moves value or signs, check it flows through `policyGate` (`apps/sdp-api/src/middleware/policy-gate.ts`) and maps to an operation family in `WALLET_OPERATION_FAMILIES` (`packages/sdp-types/src/policy.ts`). An operation that fits no existing family → flag that a new family plus rule support in `@sdp/policy/src/rules/` is needed, don't shoehorn it. When the change shifts what an existing operation means, ask whether orgs' active wallet or api-key policy revisions still say what they intended — semantics drift under a policy is a finding even when the code is correct.
- **Encryption at rest** — when the change persists a new field, ask what it holds before accepting the column type. Credentials, key material, or sensitive provider data → must round-trip through the KMS-backed crypto (`apps/sdp-api/src/lib/gcp/kms-client.ts`; `lib/spc-credential-crypto.ts` is the pattern), never a plaintext column. SSN/CDD/bank details → never persisted at all, JIT pass-through to the provider only.
- **Kora budgets** — when the change makes Kora sponsor anything new (fees, ATA rent, a new sponsored instruction), check the spend is admitted and debited through the sponsorship budget path (`apps/sdp-api/src/services/sponsorship-budget.service.ts`). Sponsored spend that bypasses the budget is a finding.
- **Metered quota** — when the change adds or exposes a route that costs real money or provider calls (signing, provider-backed, RPC-heavy), check it's mounted behind `meteredQuota` (`apps/sdp-api/src/middleware/metered-quota.ts`) like the other paid routes. An unmetered paid route is a finding; say which existing metered route to mirror.

## 6. Code distribution

Classify the changed lines (added/modified, ignore deletions, lockfiles, snapshots, generated files) and report percentages as a short table:

- **Core logic** — domain/business logic: handlers, services, policy decisions, provider flows, UI behavior.
- **Hand-rolled utilities** — general-purpose helpers written in this change instead of reused. High % here is a smell; cross-reference the no-hand-rolling findings.
- **Library usage** — glue that mostly configures or calls packages/framework (zod schemas, SQL via the query builder, SWR/route wiring, DS components).
- **Cases tested** — test code. Also note in one line what fraction of the new core-logic paths have a covering test, not just the line share.

Add extra categories when the diff warrants (migrations, config/infra, types/contracts, docs/copy) rather than forcing lines into the four. Estimate by reading the diff — no tooling, round to 5%, must sum to 100%.
