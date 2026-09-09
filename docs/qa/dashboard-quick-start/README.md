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

Focused tests cover initial modal/minimization, navigation without premature completion, dismissal, completion from successful creation, completed and unknown server states, organization/project isolation, disabled custody, unavailable browser storage, cross-tab dismissal, bounded sync polling, access failures, and monotonic persisted progress. Both web and API typechecks pass.

The unsynced and already-onboarded scenarios were checked with deterministic tests, not new live Clerk organizations.
