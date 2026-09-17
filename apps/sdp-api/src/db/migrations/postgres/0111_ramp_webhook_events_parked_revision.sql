-- Records WHICH deployed build exhausted a ramp webhook event, so the
-- replay job can re-arm parked rows exactly once per deploy: a row parked on
-- an older revision goes back to pending after the next rollout — the fix
-- that rollout carries gets to try — while a row parked on the CURRENT
-- revision stays parked, because retrying the same code against the same
-- payload only burns attempts. NULL (rows parked before this column, or a
-- runtime with no release identity) re-arms once and then carries the
-- current revision like any other row.

ALTER TABLE ramp_webhook_events
  ADD COLUMN IF NOT EXISTS parked_app_revision TEXT;

COMMENT ON COLUMN ramp_webhook_events.parked_app_revision IS
  'Image build SHA (SDP_BUILD_SHA) that exhausted this event''s replay attempts. Compared on each replay pass: a mismatch re-arms the row.';
