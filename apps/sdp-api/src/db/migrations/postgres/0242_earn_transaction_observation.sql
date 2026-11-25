-- Scheduling hints live beside the signed financial rows. Defaults admit work
-- inserted by the previous revision while this additive migration is rolling out.
ALTER TABLE earn_movements
    ADD COLUMN observation_due_at TIMESTAMPTZ,
    ADD COLUMN observation_claim_token TEXT,
    ADD COLUMN observation_claim_until TIMESTAMPTZ;

ALTER TABLE earn_vault_withdrawal_request_actions
    ADD COLUMN observation_due_at TIMESTAMPTZ,
    ADD COLUMN observation_claim_token TEXT,
    ADD COLUMN observation_claim_until TIMESTAMPTZ;

-- Existing rows keep NULL: recovery can pick up old in-flight signatures,
-- without adding finalized history to the queued-action observation index.
ALTER TABLE earn_movements ALTER COLUMN observation_due_at SET DEFAULT now();
ALTER TABLE earn_vault_withdrawal_request_actions
    ALTER COLUMN observation_due_at SET DEFAULT now();

CREATE FUNCTION notify_earn_transaction_due() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Hints contain no tenant, transaction or authority. Delivery follows commit.
    PERFORM pg_notify('sdp_operations_due', NEW.environment);
    RETURN NEW;
END;
$$;

CREATE TRIGGER earn_movement_observation_insert
    AFTER INSERT ON earn_movements FOR EACH ROW
    WHEN (NEW.execution_model = 'vault_direct')
    EXECUTE FUNCTION notify_earn_transaction_due();

CREATE TRIGGER earn_withdrawal_action_observation_insert
    AFTER INSERT ON earn_vault_withdrawal_request_actions FOR EACH ROW
    EXECUTE FUNCTION notify_earn_transaction_due();
