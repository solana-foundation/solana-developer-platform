-- sdp:migration-compat: breaking
UPDATE api_keys SET status = 'revoked', revoked_at = sdp_datetime_now() WHERE status = 'active';
