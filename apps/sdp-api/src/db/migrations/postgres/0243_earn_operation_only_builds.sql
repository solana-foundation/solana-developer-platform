-- Legacy submissions remain available for already exposed transactions. New
-- operation builds cannot bypass their durable worker through those routes.
ALTER TABLE earn_external_wallet_transactions
    ADD COLUMN operation_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE earn_external_wallet_withdrawal_request_transactions
    ADD COLUMN operation_only BOOLEAN NOT NULL DEFAULT FALSE;

CREATE FUNCTION sdp_earn_operation_only_build() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.operation_only AND NOT NEW.operation_only THEN
        RAISE EXCEPTION 'Earn operation-only build restriction is irreversible';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER earn_transactions_operation_only
    BEFORE UPDATE ON earn_external_wallet_transactions
    FOR EACH ROW EXECUTE FUNCTION sdp_earn_operation_only_build();
CREATE TRIGGER earn_queued_transactions_operation_only
    BEFORE UPDATE ON earn_external_wallet_withdrawal_request_transactions
    FOR EACH ROW EXECUTE FUNCTION sdp_earn_operation_only_build();
