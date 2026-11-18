# Mainnet access requests

> **Maintainers only.**

An organization asks for mainnet once, from the dashboard. SDP records the request, emails the operator alias and posts to #sdp-requests (`email.md`). Nothing here grants mainnet.

## Approve

Set `enableProductionProject` in the organization's Clerk private metadata. The Clerk webhook syncs it, and the request reads `approved`.

## Check, reset or correct a request

Run the **Back office — mainnet access** workflow (`.github/workflows/backoffice-mainnet-access.yml`) from `main`:

| Action        | What it does                                                         | Prod approval      |
| ------------- | -------------------------------------------------------------------- | ------------------ |
| `status`      | Whether the organization asked, when, and whether its email went out | none               |
| `reset`       | Clears the request, so the organization can ask again                | release-production |
| `set-country` | Corrects the declared jurisdiction; the request otherwise stands     | release-production |
- `reset` and `set-country` need a Linear ticket and a short reason. Each writes an audit entry that keeps the request as it stood, emails the alias and posts to #sdp-requests (red for a reset, blue for a correction), so nobody approves from the earlier post.
- A reset doesn't tell the requester. Reply to them from the alias.
- **The run is public**, because this repository is. Put no personal details in the reason; keep them in the ticket. The job prints only outcomes, never the requester, an email, the jurisdiction or the use case.
- The workflow runs the `sdp-<env>-backoffice-ops` Cloud Run job (`apps/sdp-api/scripts/backoffice-ops.ts`), not the incident-ops job, so it never fires the incident page.

With prod database access, `pnpm -C apps/sdp-api mainnet-access <status|set-country|reset>` does the same from a terminal and prints the full request.
