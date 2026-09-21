---
name: sdp-make-pr
description: Prepare and open an SDP pull request with a 120-word body (200 ceiling): one or two sentences, up to six one-line bullets, one verification line, a table only for three or more same-shape rows. Use when opening or updating a pull request for SDP work.
---

# SDP make PR

Prepare a reviewer-ready pull request for the current branch. First read [`../sdp-concise/SKILL.md`](../sdp-concise/SKILL.md) and apply its output contract to both the PR body and user updates.

This is an explicit PR-creation workflow. It may open a PR after the user approves the preview; it does not authorize committing, rebasing, pushing, force-pushing, or modifying code.

## 1. Pin the change set

1. Read `AGENTS.md`, `CONTRIBUTING.md`, the current branch, working-tree status, and any existing PR for the branch.
2. Default the base to `main` unless the user names another base. Inspect commits and the complete `base...HEAD` diff, including changed files and immediate callers needed to explain behavior.
3. If uncommitted changes exist, identify whether they belong to the PR and warn that they are absent from `base...HEAD`.
4. If the branch is not pushed, ask before pushing. If a PR already exists, return its URL and ask before replacing its title or body.

Done when the exact committed change set and target base are known.

## 2. Build the title and body

Use this title format:

```text
<type>(<module>): <high-level overview>
```

The module scope is required. Choose the type from the PR-title CI allowlist: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, or `test`. Use the SDP module changed by the PR as the scope, such as `payments`, `issuance`, `wallets`, `api`, `web`, or `docs`.

Example: `feat(payments): add retryable settlement polling`

Do not require or search for an issue ticket. Mention one only when the user explicitly asks for it.

**Target 120 words, ceiling 200.** The body is a routing document. Over the ceiling means a section goes, not tighter phrasing.

```markdown
<One or two sentences: what changed, and where it sits in a stack if stacked.>

- <Up to six bullets, one line each: behavior, the one mechanism a reviewer must know, what they would otherwise get wrong. **Bold the load-bearing clause.**>

Verification: <counts, not narration; name what was NOT run>.
```

Earning more space, in this order and only when true:

- One table, when three or more rows share a shape (file to change, env to status, work outside this PR to status).
- Two lines of before/after, when runtime behavior changed. Never two numbered lists.
- Headings, only past 150 words, one level.
- Screenshots (step 4) and one trimmed request/response pair (step 5). No prose around them.

Never: "how it works" sections, pseudocode, numbered runtime walkthroughs, decision-by-decision rationale, file inventories, a closing recap. Rationale that must survive lives in the repo (ADR, migration header, CLAUDE.md, code comment) and the body points at it.

## 3. Reviewer aids

Fold what a reviewer would otherwise get wrong into the bullets. Reach for a diagram, pseudocode or a state table only when the user asks, or when the change cannot be reviewed without one; then it is one compact block, not a section per mechanism.

## 4. Screenshot UI changes

When the diff touches `apps/sdp-web` UI, capture screenshots of the affected screens running on this branch:

1. Run the app locally and navigate to each changed screen with the browser tools, in a new tab (never hijack existing tabs). Save browser screenshots to disk — never `screencapture`/`osascript`.
2. Default to one "after" shot per changed screen; capture a before/after pair only when the visual delta is the point of the PR.
3. Show the saved screenshots in the preview (step 6) so the user sees them before anything is pushed.
4. After approval, upload each image with `gh`'s `--attach` flag (gh ≥ 2.99). Reference each file in the PR body under a **Screenshots** section as `![<screen>](./<file>.png)`, then pass the files on the same command: `gh pr create --attach '<path>/<file>.png#<what the screen shows>'` (repeat `--attach` per file; same flag on `gh pr edit` for existing PRs). gh uploads the asset and rewrites the body reference to the hosted URL. If some attachments fail, the PR is still created/updated with the ones that succeeded and gh exits non-zero — read the body back and fix or drop the dead references. The old orphan `pr-assets` branch workflow is retired; do not push new images there.
5. If capture fails after 2–3 honest attempts, continue without images and say so in the preview — a PR without screenshots beats no PR. Never stage or fake a screen you did not actually see.

Public repo: screenshots must show only SDP's own UI with local/devnet data — never secrets, real PII, or partner names.

## 5. API before/after evidence

When the diff changes the API contract — routes, request/response schemas, handlers, or queries in `apps/sdp-api` — prove the change with real requests, not prose:

1. Run the local API and call each affected endpoint with the local test key from [`LOCAL.md`](LOCAL.md) (git-excluded; if it is missing, ask the user for a local key instead of skipping).
2. Capture the **after** response on this branch. Capture the **before** response by running the API from the merge-base in a worktree when the delta needs live proof; otherwise reconstruct it from the old schema or tests and label it `(reconstructed)`.
3. Put the pairs in the PR body under **API before/after**: method + path, the request body when it changed, and trimmed JSON responses — only the fields that changed plus enough context to read them, never full dumps.
4. New endpoints get a single **after** example; removed endpoints get the old response plus the new error.
5. **Tenant isolation is proven, not asserted**: every NEW endpoint's evidence includes a cross-tenant probe — request a resource id that exists but belongs to another org/project (or a well-formed foreign id) with the local key and show the 404, plus the unauthenticated 401. A new endpoint whose PR lacks this probe is not ready to open.
6. Redact anything sensitive (keys, tokens, account numbers) and never paste the local key itself into the PR.

**Database schema changes** get the same treatment: when the diff includes migrations (`apps/sdp-api/src/db/migrations/**`), show before/after for each affected table with real `psql` output, under a **Schema before/after** section:

1. Before: from a checkout without the migration (merge-base worktree, or capture before applying it locally), run `psql "$DATABASE_URL" -c '\d <table>'` (local default `postgresql://sdp:sdp@127.0.0.1:5432/sdp`); use `\dt <pattern>` first when the affected tables aren't obvious. After: the same commands with the migration applied.
2. Trim each dump to the changed columns, indexes, and constraints plus enough context to read them — never full table dumps for wide tables, and schema only, never row data.
3. A new table gets a single **after** `\d`; a dropped one gets the old `\d` plus the migration line that drops it.

## 6. Verify and preview

Run checks proportional to the changed surface using `AGENTS.md` and `CONTRIBUTING.md`. Never claim a check ran when it did not. Distinguish passed, failed, and not run.

**Verification in the actual app is required, not optional.** Typecheck + unit tests alone do not qualify a PR that changes runtime behavior:

- `apps/sdp-web` changes: launch the local app and exercise the changed screens in the browser (this is the same session as the step-4 screenshots — one launch covers both).
- `apps/sdp-api` changes: hit the changed endpoints against the running local API (the step-5 evidence run covers this).
- Record what was exercised as a **Verification** bullet (`local app: <flow walked> — <result>`), and if the app could not be launched or the flow could not be reached, say so explicitly in the preview and PR body — never imply app verification happened when it did not.

Show one concise preview containing:

1. Base and branch.
2. Proposed title.
3. Full proposed body.
4. Checks and any blockers.

Ask for one confirmation before the external write unless the user explicitly requested creation without a preview.

## 7. Open the PR

Create the PR with the available GitHub capability, preserving the previewed title, body, base, and draft state. Read the created PR back once to verify them. Report only the PR URL, whether it is draft, and any check that remains unresolved.
