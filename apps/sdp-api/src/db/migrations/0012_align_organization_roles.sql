UPDATE organization_members
SET role = CASE
  WHEN role = 'owner' THEN 'admin'
  WHEN role IN ('developer', 'viewer') THEN 'member'
  ELSE role
END
WHERE role IN ('owner', 'developer', 'viewer');

UPDATE invitations
SET role = CASE
  WHEN role = 'owner' THEN 'admin'
  WHEN role IN ('developer', 'viewer') THEN 'member'
  ELSE role
END
WHERE role IN ('owner', 'developer', 'viewer');
