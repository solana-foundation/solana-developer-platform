# Beta cutover: production serves mainnet only

After the cutover, `platform.solana.com` serves mainnet only and the hosted sandbox lives on
`platform-beta.solana.com`. Sign-up on production stays open. An organization SDP has not
approved for mainnet can only read its own organization and request mainnet access; everything
else answers 403 with `reason: "organization_not_admitted"`. Beta takes no mainnet requests: it
links to production instead.

Nothing changes until the switches below are set, so the code ships ahead of the window.

## Switches

| Switch                          | Where                                      | Set to at the window | What it does                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SDP_ALLOW_SANDBOX_PROJECTS`    | Production API env (sdp-infra prod tfvars) | `"false"`            | Hides and refuses sandbox projects, creates no sandbox project for a new organization, registers no sandbox cron work, and locks organizations without mainnet access to the mainnet request page. |
| `SDP_ALLOW_PRODUCTION_PROJECTS` | Beta API env                               | `"false"` (already)  | Beta serves the sandbox only and refuses mainnet requests.                                                                                                                                         |
| `sandbox-on-beta`               | Production `sdp-web` Vercel project        | on                   | "Try the sandbox" links to beta on the homepage, the sign-in page, the workspace switcher and the mainnet request page.                                                                            |
| `beta-label`                    | Beta `sdp-web` Vercel project              | on                   | A Beta badge beside the product name on the homepage and the sign-in, sign-up, terms and mainnet request pages.                                                                                    |

Unset means allowed for both API switches. Any value other than `true` or `false` fails at boot,
and so does setting both to `false`.

Each Vercel flag is decided by Vercel Flags when the project defines a flag with that key, and
otherwise by its environment fallback (`SDP_FLAG_SANDBOX_ON_BETA`, `SDP_FLAG_BETA_LABEL`), which
defaults to off. Defining the flag in Vercel Flags lets it flip without a redeploy; the
environment fallback needs one.

## Before the window

1. The API and dashboard changes are deployed to production with `SDP_ALLOW_SANDBOX_PROJECTS`
   unset. Production behaves as before.
2. The beta deployment is live and its sign-up works end to end.
3. Bot sign-up protection is on for the production Clerk instance, since production sign-up stays
   open.
4. Owners of existing production sandbox projects are told the projects move out of view. They are
   hidden and refused, not deleted.
5. `sandbox-on-beta` exists on the production `sdp-web` project and `beta-label` on the beta one,
   both off.
6. Rehearse on stage: set `SDP_ALLOW_SANDBOX_PROJECTS` to `false` there and run the checks below.
   Stage's synthetic traffic runs on a sandbox project, so give its organization mainnet access or
   point the traffic at production projects first.

## The window, in order

Each step can be undone on its own.

1. **Open beta sign-up** in the beta Clerk instance, so the production links in step 4 never point
   at a closed door.
2. **Turn on `beta-label`** on the beta `sdp-web` project.
3. **Make production mainnet-only:** set `SDP_ALLOW_SANDBOX_PROJECTS = "false"` in the sdp-infra
   prod tfvars and apply. Wait for the new API revision to serve, then check:
   - an organization with mainnet access lands on its Production project, and no sandbox is listed;
   - a new sign-up creates an organization with a production project only and lands on
     `/mainnet-access`, where the request sends;
   - that new organization's API key routes answer 403 `organization_not_admitted`.
4. **Turn on `sandbox-on-beta`** on the production `sdp-web` project, then check that the homepage
   and sign-in page link "Try the sandbox" to beta.
5. Publish the docs changes that send sandbox readers to beta.

## Approving mainnet

Unchanged: set `enableProductionProject` in the organization's private metadata on the production
Clerk instance. The webhook syncs it, the organization's next visit lands on its Production
project, and its admins get the "Mainnet enabled" email. That email, and "Mainnet disabled", are
sent even when the organization turned alert emails off.

## Rollback

- Vercel flags: turn them off. Immediate.
- `SDP_ALLOW_SANDBOX_PROJECTS`: unset it and apply. One API revision; sandbox projects reappear as
  they were.
- Clerk sign-up modes: set them back.

No data migration is involved, so there is nothing to undo in the database.
