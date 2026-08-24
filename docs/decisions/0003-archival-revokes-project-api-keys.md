# ADR 0003: Project archival revokes API keys atomically

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** SDP API team
- **Related:** Security finding SDP-003 ([report](https://gist.github.com/WarlordSam07/f68035f8dfc7370d8ffea146917cc973)), audited commit `4a233db`

## Context

`DELETE /v1/projects/{projectId}` is documented as archiving a project and
preventing future writes, but the implementation only updated `projects.status`.
Project API keys stayed active, were never removed from the KV auth cache, and
API-key authentication never checked project lifecycle state. Existing keys —
including administrator keys that could mint fresh ones — kept full write access
to archived projects indefinitely, while human actors received 404.

## Decision

Archival is **terminal** and **revokes credentials**, enforced in four layers:

1. **Archive transaction**: lock the project row (`SELECT … FOR UPDATE`), set
   `status = 'archived'`, deactivate every active API key on the project
   (`status = 'deactivated'`, `revoked_at` set), returning key hashes.
2. **Cache invalidation after commit**: delete each `key:{hash}` entry from the
   API-key KV store, mirroring the existing single-key revocation flow.
3. **Cold-auth backstop**: the API-key database lookup in `authMiddleware`
   requires `p.status = 'active'`. A missed or failed KV delete self-heals when
   the entry expires (≤ 1h TTL).
4. **Approved-operation replay**: the replay key reload applies the same
   active-project condition, freezing pending wallet operations on archived
   projects.

Archived projects have **no API access at all** — reads included — matching the
existing human-actor behavior (404, dashboard visibility via `includeArchived`
only).

### Considered options

- **Guard-only** (check project status at each mutating handler, leave keys
  active): rejected. Every current and future mutating surface — including
  key minting and operation replay — must carry the guard forever; one miss
  reopens the vulnerability, and surviving admin keys could still mint
  credentials.
- **Suspend/resume semantics** (archival pauses keys): rejected. No unarchive
  path exists, and resumable revocation reintroduces the stale-credential
  problem this decision exists to close.

## Consequences

- A request that authenticates immediately before the archive transaction
  commits can still complete its write (millisecond intra-request window). We
  accept this rather than locking the project row inside every mutating
  transaction. The archive transaction itself serializes against concurrent
  archives.
- Pending approval requests on an archived project become permanently
  unresolvable (replay auth fails). Cancelling them at archive time is correct
  domain behavior but is deferred to a follow-up.
- A one-off backfill deactivates active keys on already-archived projects; the
  cold-auth backstop bounds their remaining validity to the KV TTL.
- "Deactivated" does not distinguish admin revocation from archival; if product
  needs that distinction later it is an additive metadata change.
