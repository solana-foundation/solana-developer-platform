-- Allow API keys to carry multiple active control profiles so policy-scoped
-- wallet bindings can use per-wallet overrides. The unbound/default API key
-- policy resolver still selects the latest active profile for legacy callers.

DROP INDEX IF EXISTS idx_api_key_control_profiles_active_key;

CREATE INDEX IF NOT EXISTS idx_api_key_control_profiles_active_key
    ON api_key_control_profiles(api_key_id, activated_at DESC NULLS LAST, created_at DESC)
    WHERE status = 'active';
