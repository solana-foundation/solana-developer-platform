# UI flow matrix

Maps every dashboard section to the Playwright spec that exercises its
critical flows. `GAP` means the section is only touched by the read-only page
sweep (`gcp-read-only-z-pages.e2e.spec.ts`), which verifies the page renders
but not that its flows work.

`scripts/check-ui-flow-coverage.mjs` runs in CI and fails when a dashboard
section is missing from this table, when a row references a spec file that no
longer exists, or when a row names a section that was removed. Adding a new
dashboard section therefore requires adding a row here — either with its spec
or with an explicit `GAP`.

| Section | Critical flows | Spec |
| --- | --- | --- |
| allowlist | manage the address allowlist | GAP |
| api-keys | create, reveal, and revoke API keys | api-keys.e2e.spec.ts |
| approvals | review and act on pending approvals | GAP |
| custody | custody overview and operations | GAP |
| helius-rings | ring configuration | GAP |
| integrations | connect and manage integrations | GAP |
| issuance | issue a token end to end | issuance.e2e.spec.ts |
| markets | market listings and detail | GAP |
| members | invite members and manage roles | GAP |
| onboarding | first-run workspace onboarding | onboarding.e2e.spec.ts |
| payments | transfer, recurring payments, command center | payments-transfer.e2e.spec.ts, payments-recurring.e2e.spec.ts, payments-command-center.e2e.spec.ts |
| policies | create and edit policy rules | policies.e2e.spec.ts |
| settings | workspace settings | GAP |
| tokens | token management | GAP |
| wallets | create and manage wallets | wallets.e2e.spec.ts |

Non-dashboard flows with dedicated specs: sign-in/sign-up entry
(`auth-entry.e2e.spec.ts`), theming (`theme.e2e.spec.ts`), private channels
(`private-channels.e2e.spec.ts`).
