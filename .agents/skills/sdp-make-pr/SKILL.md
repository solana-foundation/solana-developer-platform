---
name: sdp-make-pr
description: Prepare and open an SDP pull request with a concise technical summary, before/after behavior, flow or pseudocode, verification, and risk notes.
disable-model-invocation: true
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

Write the body with a concise summary first and the technical behavior second. Explain only the changed seam: name the user-visible or operational result, the mechanism that produces it, the important failure semantics, and the evidence that verifies it. Omit unchanged architecture and background that does not help review the diff.

```markdown
- <3–7 short bullets: behavior, mechanism, important failure semantics, tests>

**before** — <name the old runtime flow>:

1. <old step>
2. <old step>
3. <failure, stall, duplicate, or limitation>

**after** — <name the new runtime flow>:

1. <new step>
2. <new step>
3. <how success, retry, failure, or terminal state now behaves>

## How <changed mechanism> works <!-- only when the mechanism needs proof -->

<compact flow, pseudocode, query, state transition, or API example>

**Verification**

- `<exact command>` — <result>

Known gaps <!-- only real, scoped follow-ups -->
- <gap and tracking link when one exists>
```

## 3. Explain before and after technically

The before/after section is mandatory for behavior changes. It must compare runtime behavior, not filenames.

Good:

```text
before: confirmed row -> processing-only poll -> row never selected again
after:  confirmed row -> rotating finalization poll -> finalized or retried later
```

Weak: “Before: old service. After: new service.”

Include at least one reviewer aid in every PR:

- Numbered flow for ordering, orchestration, or failure isolation.
- State transition for lifecycle changes.
- Pseudocode for branching or algorithm changes.
- Compact SQL/API example for persistence or contract changes.

Use both a flow and a mechanism section only when each answers a different reviewer question.

## 4. Verify and preview

Run checks proportional to the changed surface using `AGENTS.md` and `CONTRIBUTING.md`. Never claim a check ran when it did not. Distinguish passed, failed, and not run.

Show one concise preview containing:

1. Base and branch.
2. Proposed title.
3. Full proposed body.
4. Checks and any blockers.

Ask for one confirmation before the external write unless the user explicitly requested creation without a preview.

## 5. Open the PR

Create the PR with the available GitHub capability, preserving the previewed title, body, base, and draft state. Read the created PR back once to verify them. Report only the PR URL, whether it is draft, and any check that remains unresolved.
