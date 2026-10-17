-- sdp:migration-compat: breaking
ALTER TABLE api_keys ALTER COLUMN role DROP DEFAULT;
