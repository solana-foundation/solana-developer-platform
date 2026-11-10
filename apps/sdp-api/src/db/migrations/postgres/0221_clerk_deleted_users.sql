-- HOO-2303: the lasting record that Clerk deleted a Clerk user. A deleted Clerk
-- user never comes back, so any later event that names one (a late or retried
-- `user.created` or `user.updated`) is stale and must not store the details the
-- deletion removed. A deletion can arrive before SDP ever linked the person, when
-- there is no identity row to tombstone, so the record is its own row, keyed by the
-- Clerk user alone. It holds nothing else about the person.
--
-- Global, like `users` and `auth_user_identities`: no tenant policy (0081).
-- Expand-only: a new table no previous revision reads.
--
-- `status` is the one value `deleted`: a record is never archived, since an
-- archived one would let a late event store the person again.
CREATE TABLE IF NOT EXISTS clerk_deleted_users (
    clerk_user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'deleted' CHECK (status IN ('deleted')),
    deleted_at TEXT NOT NULL DEFAULT sdp_iso_now()
);
