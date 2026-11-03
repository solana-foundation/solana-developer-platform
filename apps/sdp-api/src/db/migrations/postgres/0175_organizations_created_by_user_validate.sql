-- Validates the creator foreign key 0173 added NOT VALID. The column is new and NULL on every
-- existing row, so the scan finds nothing to check, and VALIDATE does not block writes.
ALTER TABLE organizations
    VALIDATE CONSTRAINT organizations_created_by_user_id_fkey;
