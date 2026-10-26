-- The read-only `viewer` organization role (HOO-2282) joins `admin` and `member`
-- (`ORGANIZATION_ROLES` in @sdp/types/roles). Widening the CHECK is a drop and re-add, which
-- refuses nothing the previous image writes; it goes back NOT VALID so the add takes no
-- blocking scan, and 0183 validates it. An image from before this change reads a `viewer` row
-- as `member`, so a viewer is created only once this revision serves.
ALTER TABLE organization_members
    DROP CONSTRAINT organization_members_role_check,
    ADD CONSTRAINT organization_members_role_check
    CHECK (role IN ('admin', 'member', 'viewer')) NOT VALID;
