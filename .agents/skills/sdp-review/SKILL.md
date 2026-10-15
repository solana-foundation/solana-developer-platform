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
- Workspace packages touched or consumed (`apps/sdp-api`, `apps/sdp-web`, `packages/sdp-types`, `@sdp/payments`, …) and what for.
- External dependencies newly added or leaned on in this change (from `package.json` diffs and new imports). No new deps → say so in one bullet.

Keep the whole digest under ~30 bullets. If the change set is bigger than that, group by domain and compress — digestibility beats completeness.

## 4. Review pass

Read [`docs/contributing/code-standards.md`](../../../docs/contributing/code-standards.md) and check the changed code against every section. It is the single rulebook, shared with Greptile; never restate its rules here. Findings only: a rule with no violation is skipped silently. Each finding: `file:line`, the section it breaks, what's wrong, the concrete fix. All clean → one line: "Review pass clean."

For **Platform obligations**, verify instead of asking: when a change triggers one, read the route wiring, the migration, or the service and confirm the obligation is handled. Nothing triggered → one line: "No product obligations triggered."

Then run the checks a static reviewer can't:

- **Kit exports.** For every changed Solana-facing type, helper, instruction, transaction, RPC operation, signer flow, or amount calculation, check the APIs exported by the repository's pinned `@solana/kit` and the official `@solana/*` packages the affected workspace already declares.
- **Pinned dependencies.** When package manifests or workspace catalogs change, run `pnpm check:pinned-dependencies`, and scan the touched workspace for dependencies no longer imported anywhere.
- **React Doctor.** When the change set contains `.jsx` or `.tsx` source files, use the repository's installed version and run `pnpm exec react-doctor --verbose --scope changed --base <resolved-base-ref>`. Keep `scope` set to `changed`; never substitute a full-project scan or fetch a different version with `npx`. If the local binary is unavailable, ask whether the user wants to install an exact local version or rely on the existing changed-scope React Doctor CI check. Never install implicitly. If they choose CI, skip the local scan and report it as pending until the PR check completes. Fold introduced diagnostics into the review findings with the same `file:line` / problem / fix format.

## 5. Code distribution

Classify the changed lines (added/modified, ignore deletions, lockfiles, snapshots, generated files) and report percentages as a short table:

- **Core logic** — domain/business logic: handlers, services, policy decisions, provider flows, UI behavior.
- **Hand-rolled utilities** — general-purpose helpers written in this change instead of reused. High % here is a smell; cross-reference the no-hand-rolling findings.
- **Library usage** — glue that mostly configures or calls packages/framework (zod schemas, SQL via the query builder, SWR/route wiring, DS components).
- **Cases tested** — test code. Also note in one line what fraction of the new core-logic paths have a covering test, not just the line share.

Add extra categories when the diff warrants (migrations, config/infra, types/contracts, docs/copy) rather than forcing lines into the four. Estimate by reading the diff — no tooling, round to 5%, must sum to 100%.
