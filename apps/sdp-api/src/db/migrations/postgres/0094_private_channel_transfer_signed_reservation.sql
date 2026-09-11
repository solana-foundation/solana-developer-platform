-- Commit 6f0c3e04e added signature-before-send but left the original CHECK intact.
-- The transfer service records a signature before send while it still owns the
-- pending reservation. A crash in that window must remain observable by replay
-- recovery; the original constraint rejected this write and prevented any send.
ALTER TABLE private_channel_transfers
    DROP CONSTRAINT private_channel_transfers_result_check,
    ADD CONSTRAINT private_channel_transfers_result_check
        CHECK (
            (status = 'pending' AND failure_reason IS NULL)
            OR (status = 'submitted' AND signature IS NOT NULL AND failure_reason IS NULL)
            OR (status = 'confirmed' AND signature IS NOT NULL AND failure_reason IS NULL)
            OR (status = 'failed' AND failure_reason IS NOT NULL)
        );
