ALTER TABLE issued_tokens ADD COLUMN metadata_authority TEXT;

UPDATE issued_tokens
SET metadata_authority = mint_authority
WHERE metadata_authority IS NULL;
