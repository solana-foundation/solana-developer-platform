# Self-Hosted Clerk Setup

This guide walks an operator through wiring up their own Clerk tenant for a self-hosted SDP deployment. Follow it after you have the API and dashboard running with `SDP_DEPLOYMENT_MODE=self_hosted` (see [`apps/sdp-api/README.md`](../../README.md#self-hosted-mode-no-third-party-providers)).

The Clerk webhook handler is the only path that creates `organizations` rows outside `pnpm db:seed:local`. Without the steps below, sign-ups will succeed in Clerk but the API will reject every authenticated request with `Active Clerk organization required` (the JWT does not contain `org_id` by default — see step 3).

Time estimate: under 30 minutes against a fresh Clerk account.

---

## 1. Create a Clerk account and application

1. Sign up at https://clerk.com (free tier is sufficient for self-hosted SDP).
2. Create a new application; choose email/password sign-in (or any provider you prefer).
3. From the application's **API Keys** page, capture:
   - Publishable key (`pk_test_...` for dev, `pk_live_...` for prod)
   - Secret key (`sk_test_...` / `sk_live_...`)
4. **Enable Organizations**: Clerk dashboard → **Organizations Settings** → toggle **Enable organizations**. SDP is org-scoped; the API rejects tokens that lack `org_id`.

## 2. Set Clerk environment variables

In `apps/sdp-web/.env.local`:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_JWT_TEMPLATE=sdp-api
```

In `apps/sdp-api/.dev.vars`:

```bash
CLERK_ISSUER=https://<your-instance>.clerk.accounts.dev
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...   # filled in step 4
# CLERK_AUDIENCE=                # only set if you configure an audience claim in step 3
# CLERK_JWKS_URL=                # defaults to ${CLERK_ISSUER}/.well-known/jwks.json
```

`CLERK_ISSUER` is shown in the Clerk dashboard under **API Keys → JWT Templates → Issuer** (looks like `https://<slug>.clerk.accounts.dev` for dev instances or your custom domain in prod).

## 3. Create the JWT template

Clerk's default session token does not include `org_id`. Without a custom JWT template, the API will reject every request because `clerk-token.ts` requires both `sub` and `org_id` claims. This step is mandatory.

1. Clerk dashboard → **JWT Templates** → **New template** → **Blank**.
2. **Name**: `sdp-api` (must match the `CLERK_JWT_TEMPLATE` env var set in step 2).
3. **Token lifetime**: 60 seconds (default). The dashboard fetches a fresh token per API call.
4. **Claims** (paste this into the editor):

   ```json
   {
     "org_id": "{{org.id}}",
     "org_role": "{{org.role}}",
     "org_slug": "{{org.slug}}",
     "email": "{{user.primary_email_address}}"
   }
   ```

5. Save the template.

What each claim does:

| Claim | Required? | Used by |
|---|---|---|
| `sub` | yes | User identity; checked in `clerk-token.ts` and threaded through every request as the actor |
| `org_id` | yes | Organization scope; the request is rejected if missing |
| `org_role` | recommended | Maps `"org:admin"` to admin, anything else to member (`clerk-role.ts`); without it everyone is a member |
| `org_slug` | optional | Surfaced in some logs and audit events |
| `email` | optional | Used for actor display and notifications; the API also falls back to `email_addresses[0].email_address` if you prefer Clerk's default shorthand |

When testing, sign in to Clerk's hosted UI with an **active organization selected**. Tokens minted without an active org omit `org_id` and the API rejects them.

## 4. Set up the webhook relay (local dev)

Clerk webhooks need a public HTTPS URL. Wrangler dev runs on `http://localhost:8787`. Use the official Svix CLI to relay webhooks to localhost — Clerk's webhook infrastructure is built on Svix and the CLI is the native local-dev tool. No third-party tunneling service needed.

1. Install the Svix CLI:

   ```bash
   # macOS
   brew install svix/svix/svix-cli

   # any platform with Node
   npm install -g svix-cli

   # other platforms: https://docs.svix.com/cli
   ```

2. In one terminal, start the API:

   ```bash
   pnpm --filter @sdp/api dev
   ```

3. In a second terminal, start the relay:

   ```bash
   svix listen http://localhost:8787/webhooks/clerk/link-orgs
   ```

   The CLI prints a public URL like:

   ```
   https://play.svix.com/in/e_<token>/
   ```

4. Configure the Clerk webhook endpoint:
   - Clerk dashboard → **Webhooks** → **Add Endpoint**.
   - **Endpoint URL**: paste the `https://play.svix.com/in/e_<token>/` URL from the previous step.
   - **Subscribe to events** (subscribe to all nine — the handler at `routes/webhooks/handlers.ts` processes the full set):
     - `organization.created`
     - `organization.updated`
     - `organization.deleted`
     - `user.created`
     - `user.updated`
     - `user.deleted`
     - `organizationMembership.created`
     - `organizationMembership.updated`
     - `organizationMembership.deleted`
   - Save the endpoint.

5. Copy the endpoint's **Signing Secret** (`whsec_...`) into `apps/sdp-api/.dev.vars` as `CLERK_WEBHOOK_SECRET`.

6. Restart the API so it picks up the new secret:

   ```bash
   pnpm --filter @sdp/api dev
   ```

The Svix CLI ships a built-in inspection UI ("Svix Play") that lets you replay events against your local API while iterating on webhook handler code — useful when debugging the org-link flow.

In production self-hosted deployments, point Clerk directly at the deployment's public URL (e.g. `https://api.example.com/webhooks/clerk/link-orgs`); Svix CLI is for dev only.

## 5. Verify end-to-end

1. Open the dashboard (`pnpm --filter sdp-web dev`, `http://localhost:3000`).
2. Sign up via Clerk's hosted UI; create an organization when prompted.
3. Confirm the webhook landed by querying Postgres:

   ```bash
   psql "${DATABASE_URL:-postgresql://sdp:sdp@127.0.0.1:5432/sdp}" -c "SELECT id, clerk_organization_id, name, tier FROM organizations;"
   ```

   You should see one row with `clerk_organization_id` matching the org you just created.
4. From the dashboard, navigate to any authenticated page (wallets, settings). The API call should succeed — the JWT template is verified and `sub` + `org_id` resolve correctly.
5. With `SDP_DEPLOYMENT_MODE=self_hosted`, the org's tier does not matter; every configured provider is entitled. If a provider picker is empty, that provider's env vars are not set in `.dev.vars`.

## Troubleshooting

- **API returns `Active Clerk organization required`** — the JWT lacks `org_id`. Confirm `CLERK_JWT_TEMPLATE=sdp-api` in the web env, the template name in Clerk matches exactly, the payload includes `"org_id": "{{org.id}}"`, and you signed in with an active organization selected.
- **Webhook signature verification fails** — `CLERK_WEBHOOK_SECRET` does not match the endpoint's signing secret in Clerk. Re-copy the secret from the endpoint detail page, restart the API.
- **`organizations` row never appears** — the Svix relay is not running, or the Clerk endpoint URL points at an old Svix Play URL. Check the Svix CLI terminal for delivery logs; check the Clerk endpoint's **Message Attempts** tab for HTTP errors.
- **Token verification fails with `unable to retrieve JWKS`** — `CLERK_ISSUER` is wrong. The default JWKS path is `${CLERK_ISSUER}/.well-known/jwks.json`; load that URL in a browser to confirm Clerk returns a JSON document.
