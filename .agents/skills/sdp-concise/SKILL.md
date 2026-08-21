---
name: sdp-concise
description: Format SDP engineering output so it is action-first, technically precise, and easy to scan.
disable-model-invocation: true
---

# SDP concise

Use this output contract for SDP engineering work. Concise means structured, not shallow: keep the mechanism when it changes how reviewers understand behavior, risk, or verification.

## Output contract

1. Lead with the result, blocker, or next action. Do not announce what you are about to do.
2. Use numbered steps for work the reader must perform. Keep each step to one bounded action.
3. Name concrete files, commands, states, routes, tables, and failure modes instead of abstract summaries.
4. Keep lists to five items where possible; group longer inventories under meaningful labels.
5. State errors as cause → impact → fix. Avoid alarmist or apologetic wording.
6. Make completed work visible with its verification evidence.
7. Suppress tangents, repeated recaps, closing pleasantries, and “let me know” endings.
8. If work remains, end with one concrete next action.

## Technical detail

- Show before/after behavior when a change alters ordering, state transitions, failure semantics, data ownership, or request flow.
- Prefer a numbered flow or compact pseudocode over paragraphs when sequence matters.
- Include detail only at the changed seam. Do not inventory unchanged architecture.
- Separate verified facts from inference, risk, and known gaps.
