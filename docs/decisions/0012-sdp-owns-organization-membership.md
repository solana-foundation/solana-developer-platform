# ADR 0012: SDP owns organization membership; Clerk only proves identity

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** SDP engineering
- **Related:** HOO-1972; `apps/sdp-api/src/middleware/clerk-auth.ts`; `apps/sdp-api/src/routes/members/`; `apps/sdp-api/src/routes/webhooks/handlers.ts`

## Context

Membership had two writers. SDP's API wrote `organization_members`, and Clerk
let any `org:admin` change memberships and roles from the browser: the
Frontend API (`organization.updateMember`, `removeMember`, `inviteMember`) is
callable from devtools with the session alone, so hiding the UI is not a
boundary. Clerk's changes reached SDP through webhooks that can arrive late,
out of order, or not at all, and sign-in provisioned SDP memberships from the
Clerk role. A delayed demotion left a former admin able to mint keys; an
out-of-order update could reactivate a removed member; sign-in recreated
project access an admin had revoked.

Clerk's system permissions gate its Frontend API, but the built-in `org:admin`
keeps "Manage members" and our plan has no custom roles, so the role Clerk
calls admin can always write memberships.

## Decision

- **Every person is `org:member` in Clerk, whatever their SDP role.** In a
  development instance, an `org:member` was refused every membership write
  through the Frontend API (`403 missing_organization_permission`: promoting
  someone, promoting themselves, inviting, removing), while the same call as
  an `org:admin` succeeded.
- **SDP's database is the only source of a person's Organization Role.**
  Backend authorization reads it on every request; the dashboard reads it from
  the API (`GET /v1/members/me`), never from the Clerk token.
- **SDP makes every Clerk membership write with its secret key and names no
  person.** Organizations are created with no `createdBy` (they start with no
  members and no one holds Clerk's creator role). Invitations name no inviter:
  Clerk checks a named inviter's org permissions even on Backend API calls, so
  an `org:member` inviter is refused. User-created organizations are disabled
  in Clerk.
- **Clerk may take access away, never grant it.** Webhooks that delete a
  membership or a user are mirrored into SDP; webhooks that create a
  membership or change a role are ignored. A Clerk membership with no SDP
  admission behind it is refused at sign-in.
- **Admission happens only in SDP**: creating an organization (the creator
  becomes its first admin) or the first sign-in matching a pending SDP
  invitation. Admission grants both default projects once; nothing re-grants
  them.
- **SDP enforces what Clerk no longer does**: an organization always keeps an
  admin, an admin never changes their own role or leaves, and a person creates
  at most one organization.

## Considered Options

- **Compare the Clerk token's role with SDP's and take the lower.** Bounds a
  Clerk-side demotion to the token's 60-second lifetime, but keeps two writers
  and every webhook-ordering problem.
- **Check Clerk's Backend API on every request.** Fresh, but rate-limited
  instance-wide, adds latency to every call, and still trusts a role an admin
  can edit from devtools.
- **Custom read-only Clerk roles as labels.** Cleaner in the Clerk Dashboard,
  but not available on our plan; the built-in `org:admin` cannot lose "Manage
  members" and cannot stop being the creator role.

## Consequences

- Clerk's role labels carry no meaning; SDP code never maps them to a role.
- Operator entitlements (`enableProductionProject`, `providerOverrides`) still
  arrive from Clerk organization `private_metadata`, writable only through the
  Backend API or the Clerk Dashboard. That is the one remaining Clerk path that
  grants anything, and it is operator-only.
- Deleting a Clerk user is an operator action; SDP accepts it even if it
  leaves an organization without an admin, and an operator restores one.
