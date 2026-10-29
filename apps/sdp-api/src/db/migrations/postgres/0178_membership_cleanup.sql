-- sdp:migration-compat: breaking
-- Membership cleanup after SDP took ownership of organization membership (HOO-1972, ADR 0012).
-- Organization roles are SDP's own two (`admin`, `member`); Clerk-era spellings fold into them
-- before the CHECK is added. Member statuses are the three in `MEMBER_STATUSES`. Both
-- constraints are added NOT VALID so they take no blocking scan; 0179 validates them.
-- Project members carry no role (the API never reads one), so the column goes. Breaking for a
-- traffic rollback by intent: an image from before ADR 0012 reads project roles and Clerk-era
-- role spellings, and ships only with the membership reset.
UPDATE organization_members
   SET role = 'admin'
 WHERE role IN ('owner', 'org:admin', 'org:owner');

UPDATE organization_members
   SET role = 'member'
 WHERE role NOT IN ('admin', 'member');

ALTER TABLE organization_members
    ADD CONSTRAINT organization_members_role_check CHECK (role IN ('admin', 'member')) NOT VALID;

ALTER TABLE organization_members
    ADD CONSTRAINT organization_members_status_check
    CHECK (status IN ('active', 'suspended', 'removed')) NOT VALID;

ALTER TABLE project_members DROP COLUMN role;

