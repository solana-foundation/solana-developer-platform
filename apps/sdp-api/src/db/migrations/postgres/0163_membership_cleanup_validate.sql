-- Validates the constraints 0162 added NOT VALID. 0162 rewrote every non-conforming role, and
-- member statuses were only ever written as one of the three, so the scan finds nothing; VALIDATE
-- does not block writes.
ALTER TABLE organization_members VALIDATE CONSTRAINT organization_members_role_check;

ALTER TABLE organization_members VALIDATE CONSTRAINT organization_members_status_check;
