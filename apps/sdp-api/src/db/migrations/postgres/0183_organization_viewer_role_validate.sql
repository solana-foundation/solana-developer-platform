-- Validates the role CHECK 0182 re-added NOT VALID. Every existing row is `admin` or `member`
-- (0179 validated that), so the scan finds nothing; VALIDATE does not block writes.
ALTER TABLE organization_members VALIDATE CONSTRAINT organization_members_role_check;
