---
name: sdp-ui-designer
description: Use when designing, prototyping, reviewing, or implementing UI for the Solana Distribution Platform (SDP), especially payments, wallets, counterparties, or issuance flows. Applies SDP-specific design rules, prototype constraints, typography, navigation, table, wizard, and issuance guidance before making UI changes.
---

# SDP UI Designer

Use this skill for any SDP UI work. Follow the SDP-specific product rules first, then use general Solana institutional design taste only where SDP does not already define a pattern.

## Quick Start For Agents

Before editing UI:

1. Confirm the task is for SDP UI.
2. Read the current task and only inspect the relevant files or screen slices.
3. Use these handoff references as the design source of truth:
   - `AGENTS.md`
   - `sdp-design-system.css`
4. Reuse SDP CSS variables, component classes, spacing, table styles, buttons, and navigation patterns before creating new ones.
5. If direct Figma is available, treat `SDP-design` as authoritative.

If this skill is shared as a standalone handoff bundle, use the included files:

- `AGENTS.md`
- `sdp-design-system.css`
- `sdp-ui-designer/SKILL.md`

Do not assume access to private prototypes, private source material, or machine-specific paths unless they are explicitly shared with the handoff recipient.

## Design Source Of Truth

- Figma: `Jj7dHZIDQ6iGZFwpo38Yhv` (`SDP-design`).
- Canonical token reference in this bundle: `sdp-design-system.css`.
- SDP product rules in this bundle: `AGENTS.md`.

Use the SDP Payments UI patterns as the product truth for shell, sidebar, navigation hierarchy, tab styling, button grammar, table styling, and general SDP density. Issuance should not invent a separate shell or app navigation pattern.

Use `sdp-design-system.css` as a portable token and component reference. If the target codebase keeps CSS inline or uses another styling system, mirror the variables and component behavior rather than introducing a second visual language.

## Visual Direction

SDP should feel like a quiet institutional operations product:

- White content surfaces on warm sand/gray app chrome.
- Subtle borders and restrained shadows.
- Dense but readable layouts.
- Operational forms, tables, side panels, and cards.
- Clear status and readiness states.
- No marketing-style heroes, decorative backgrounds, glow, or loud brand treatment.

Use the existing SDP palette:

- App background: `--sand-200`.
- Text: `--emph-xh`, `--emph-h`, `--emph-m`, `--emph-l`.
- Borders/fills: `--border-xl`, `--border-l`, `--border-m`, `--t4`, `--t8`, `--t12`.
- Primary button: `--btn-pri`.
- Secondary button: `--btn-sec`.
- Status only: green, amber, red token values from the project.

## Typography

- Use Inter only.
- Do not introduce new fonts.
- Monospace fonts are only allowed in API Playground or code surfaces.
- Do not use mono styling for wallet addresses, transaction references, token addresses, tables, settings rows, normal IDs, or product UI unless the product owner explicitly asks.
- Keep table body text one consistent size and weight.
- Do not bold table content except badges/chips.
- Use sentence case for headings and content labels unless the existing component uses compact metadata/table-header styling.

## Core Components

Reuse these SDP patterns:

- App shell with left sidebar and large rounded content card.
- Page header with title and tabs.
- Form cards with 8-12px radius and 1.5px subtle border.
- Quiet selection cards with radio/check state.
- Persistent summary or readiness rail for multi-step workflows.
- Stable footer controls for wizards and review flows.
- Tinted table header rows with uniform body text.
- Badges/chips for status only.
- Buttons inside cards for card actions; avoid marketing empty states.

Do not put cards inside cards unless the inner item is a repeated record, modal, table row group, or actual framed control.

## Navigation Rules

Payments and issuance must share the same sidebar design and information architecture. Use the established Payments UI pattern as the reference:

- Full-width SDP sidebar, not a compact icon rail, unless the product owner explicitly asks for an icon-only variant.
- Project switcher at top.
- `Create` group contains `Home` and `Wallets`.
- `Manage` group contains `Issuance`, `Payments`, and `API Keys`.
- Issuance and Payments are sibling dropdowns under `Manage`.
- When Issuance is open, Payments is collapsed.
- When Payments is open, Issuance is collapsed.
- Active sub-nav uses the same left rail indicator and text treatment as Payments.

Current issuance navigation should follow:

- `Overview`
- `Tokens`
- `Drafts`
- `Templates`
- `Approvals`

Overview is the entry point. Draft creation should start with a full-page category/classification step. Launched token management should use a card or grid locator before detail management.

Payments navigation must distinguish:

- Pay: outbound payment or payout from a wallet.
- Receive: wallet address receiving and onramp/deposit routes.
- Request: payment request creation.

Do not call payout/offramp routing an onramp.

## V2 Issuance Direction

When working on the V2 issuance draft flow, follow the approved V2 issuance direction:

- Remove list/search-management chrome when the user is actively creating a draft.
- The draft page should showcase only the creation fields.
- Keep the outer shell and sidebar consistent with Payments.
- Use a persistent right-side summary panel showing what the user has filled so far.
- Use a four-step top progress model:
  - What is this asset?
  - Asset details
  - Public information
  - Review & finish
- The sub-asset type and full asset details can both live under the broader "Asset details" progress step.
- The summary panel should update as the user fills core fields.
- Public information should clearly separate what is public from what remains private.

Recommended V2 screen structure:

1. Classification:
   - Choose classification, for example Stablecoin, Tokenized Security, Other Digital Asset.
   - Choose asset type/subtype.
   - Capture name early.
2. Sub asset type:
   - Show selected category.
   - Present supported subtypes as selection cards.
   - Keep the summary panel visible.
3. Asset details:
   - Group metadata, financial details, documents, controls.
   - Use tabs for Overview, Compliance & Access, Operational, Custom fields when needed.
   - Keep the summary panel visible.
4. Public information:
   - Show a public preview.
   - Show included public fields.
   - Show private-by-default fields separately.
5. Review & finish:
   - Confirm summary, blockers, warnings, and create draft action.

## Issuance Product Rules

SDP must support multiple issuance providers and asset mechanics. Do not hard-code the UX around a single provider.

Use guided, product-language inputs. Avoid exposing low-level chain concepts directly unless the screen is explicitly for API/export/advanced review.

Important issuance concepts to support:

- Stablecoins remain an important top-level category.
- Tokenized securities and RWAs should scale to provider-specific requirements.
- Providers may need jurisdiction, offering route, board resolution, subscription agreement, evidence, reserve/custody, access control, reporting, or lifecycle controls.
- Provider complexity should be represented as readiness tasks, requirements, warnings, approvals, and review states.

For the SSTS/Halborn-backed private-security direction:

- Supported profile codes currently in scope: `us_fund_share`, `us_private_equity_share`, `us_private_note`.
- Friendly labels are fine in normal user-facing copy.
- Persisted profile codes should be visible in preset, review, settings, export, and handoff surfaces.
- Issuers should not assemble verifier/account-meta/module internals directly.
- SDP should collect product-language inputs, readiness dependencies, approval state, and stable manifest/operation outputs.
- Post-launch should open a security-specific workspace, not return operators to the wizard.

## Tables

Tables must match SDP styling:

- Tinted header row.
- Consistent row padding.
- One consistent body text style.
- No bold table values except badges/chips.
- Status text appears in badges.
- Use subtle dividers and rounded table wrapper.

## Wallet And Counterparty Rules

- Wallet creation and created-wallet states use quiet SDP card grammar.
- Wallet cards should not feel like landing-page empty states.
- Wallet actions belong inside the relevant card or page area.
- Saved Solana address cards should show user-set name on the first line and the address on the second line.
- Do not add a `Primary` tag unless the user asks.
- The helper text "Only Solana wallet addresses are stored. Bank account details are entered at payment time." should be small and aligned with the info icon at the first line.

## Implementation Rules

- Use `rg` for search.
- Inspect relevant slices instead of dumping large files.
- Avoid unrelated refactors.
- Do not overwrite other agents' or collaborator changes.
- For UI changes, verify:
  - HTML serves or opens correctly.
  - JavaScript parses.
  - Key screens render without overflow or obvious overlap.
  - Typography and table rules are followed.

## Handoff Prompt

If using this as a plain prompt instead of an installed skill, paste this before the task:

```text
You are working on SDP UI. Follow the SDP UI Designer rules in this file. Read the included AGENTS.md, inspect the relevant screen or component, reuse SDP variables/classes, keep Inter only, avoid mono outside API/code, keep table text uniform, and follow the approved V2 issuance direction when working on issuance. Make scoped changes, verify the result, and do not overwrite unrelated work.
```
