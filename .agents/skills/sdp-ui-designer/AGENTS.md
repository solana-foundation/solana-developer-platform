# SDP UI Handoff Rules

Use these rules when designing, prototyping, reviewing, or implementing UI for the Solana Distribution Platform (SDP). This file is intended for external handoff and should be treated as a portable project guide.

## Design Source Of Truth

- Figma: `Jj7dHZIDQ6iGZFwpo38Yhv` (`SDP-design`).
- Canonical style reference in this handoff bundle: `sdp-design-system.css`.
- SDP-specific skill/instructions in this handoff bundle: `sdp-ui-designer/SKILL.md`.

## Styling Rules

- Use the in-file SDP CSS variables and existing component classes wherever possible.
- Do not introduce new fonts. Use Inter in SDP product UI and prototypes.
- Monospace fonts are only permitted inside API Playground/code surfaces.
- Do not use mono styling for wallet addresses, transaction refs, token addresses, tables, settings rows, or any other product UI unless the product owner explicitly asks for it.
- Table content should use one consistent body text style. Do not bold table text or change table text size unless the text is inside an intentional badge/chip.
- For cost efficiency, inspect only the relevant screen/CSS/JS slices before editing; avoid broad file dumps unless needed.
- Issuance navigation follows `Overview`, `Tokens`, `Drafts`, `Templates`, `Approvals`. Overview is the entry point, draft creation starts with a full-page token category step, and launched-token management uses a card/grid locator before detail management.
- Wallet creation and created-wallet states should use the established SDP card grammar: quiet provider/wallet cards, restrained labels, and action buttons inside the card rather than a marketing-style empty state.

## Issuance Case Study Memory

- Active SSTS-backed SDP issuance scope is three U.S. private-security profiles: `us_fund_share`, `us_private_equity_share`, and `us_private_note`. Friendly labels are fine, but persisted profile codes must appear in preset, review, settings, export, and handoff surfaces.
- Build posture is guided and preset-first. Issuers should not assemble verifier/account-meta/module internals directly. SDP collects product-language inputs, readiness dependencies, approval state, and stable manifest/operation outputs.
- Required launch flow is a six-screen wizard: Instrument family, Security preset, Issuer and security basics, Policy and lifecycle setup, Authorities/providers/evidence, Review and launch submission.
- Screen 4, Policy and lifecycle setup, is the most important configuration surface. It controls offering route, eligibility route, transfer posture, approval requirement, lifecycle features, profile-specific controls, and the resulting workspace tab/action map.
- Launch screens should use a shared layout: step rail, grouped main content, right-side readiness/issues panel, and stable footer controls. Support save/resume, downstream reset warnings, blocking issues, warnings, approval locks, failure/retry, and deployed workspace path.
- Post-launch must open a security-specific workspace, not return operators to the wizard. Workspace shell needs security header, profile/state badges, pending count, global actions, profile-aware tabs, readiness rail, and activity/audit strip.
- Workspace tabs are status/queues/summaries/action entry points, not full forms. Operation details should use a shared drawer/page model with action summary, profile-aware inputs, evidence/provider readiness, approvals, schedule/execution, validation, receipts/failures, and audit links.
- Evidence, provider, and approval dependencies should appear as practical tasks/readiness states. Hard blockers disable submit and link to exact remediation sections; warnings stay visible with owner/due posture.
- Settings/manifest should be read-mostly: show profile code, feature map, authorities, providers, evidence policy, and export controls without implying unsupported direct edits.
