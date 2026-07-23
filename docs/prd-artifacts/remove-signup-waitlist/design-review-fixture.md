# Organization onboarding design-review fixture

- Browser identity: `SDP E2E Admin` in the persistent Codex in-app browser session.
- Clerk organization: `SDP Design Review Sandbox`.
- Local data source: Postgres seeded by the `start-sdp-worktree` Clerk-link workflow.
- Review reset: clear `organizations.onboarding_completed_at` and remove only the
  `rpcProvider` key from `organizations.settings` for the mapped review organization.
- Do not store Clerk credentials, tokens, cookies, or provider credentials in this repository.
