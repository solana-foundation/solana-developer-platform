# Dashboard quick start QA

Local Zen walkthrough on September 9, 2026, using the branch web server on port 3103 and API on port 8791.

## Browser checks

- API-key creation: all four steps reached; Continue and Create key remain unobstructed.
- Mobile (390 × 600): form actions, guide row, and bottom navigation do not overlap.
- Opening and closing the guide preserves the form and returns keyboard focus to its launcher.
- Wallet handoff: provider selection and wallet details reached; Next and Create wallet remain unobstructed.
- Optional wallet skip reaches the USDC faucet step without requiring wallet creation.

![Mobile API-key review with a separate quick-start row](mobile.png)

No API key or wallet was created, and no faucet transaction was submitted. The Mac locked before the final completed-dashboard refresh could be visually checked.

## Automated coverage

Focused tests cover initial modal/minimization, navigation without premature completion, dismissal, completion from successful creation, completed and unknown server states, user/organization isolation, dismissal across projects, disabled custody, unavailable browser storage, cross-tab dismissal, bounded sync polling, access failures, and progress that cannot move backward.

September 10 verification: 50 focused web tests passed, along with the web typecheck, scoped Biome checks, and module-boundary generation/check. The browser screenshots above predate the persistence refactor; wallet-based suppression and browser persistence were verified with automated tests.

## Web-only eligibility and persistence

The guide uses existing organization state: legacy completion, a configured default custody wallet, or any wallet in an accessible project suppresses it. Wallet checks include all providers and omit balances. Unknown organization or wallet state does not show the guide. Creating a wallet also dismisses the guide immediately; skipping wallet setup still leads to the test USDC faucet.

Progress and dismissal live in browser storage, scoped to the user and organization, so changing projects does not reopen the guide. Dismissal is not shared with teammates or other browsers and resets when browser data is cleared. Existing wallets still suppress the guide on a new device.

No SDP API changes, organization-settings writes, shared-type changes, or database migrations are required.

The unsynced and already-onboarded scenarios were checked with deterministic tests, not new live Clerk organizations.
