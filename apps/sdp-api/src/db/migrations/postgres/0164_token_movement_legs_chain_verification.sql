-- Token movement legs verified from the chain (ADR 0012).
--
-- A transfer SDP builds and signs is verified by construction once it lands:
-- the statement that confirms it writes its legs' verdict. A movement a
-- program makes for SDP through CPI (a recurring pull) is not: its leg is
-- verified from the landed transaction, the instruction's debit and the
-- destination's raw token-balance delta. `verified_by` says which, so a
-- confirmation never marks a `chain` leg verified by construction. Every leg
-- written before this migration is a builder leg.
--
-- Two verification reasons join the set: the chain shows the quote moved
-- (`chain_delta_matched`), or it shows other amounts or none SDP can read
-- (`chain_delta_mismatch`). The constraint is replaced in one statement, and
-- the new one is added NOT VALID: every row before it holds an older reason.

ALTER TABLE token_movement_legs
    ADD COLUMN IF NOT EXISTS verified_by TEXT NOT NULL DEFAULT 'construction'
        CHECK (verified_by IN ('construction', 'chain'));

ALTER TABLE token_movement_legs
    DROP CONSTRAINT token_movement_legs_verification_reason_check,
    ADD CONSTRAINT token_movement_legs_verification_reason_known CHECK (
        verification_reason IN (
            'sdp_built_transfer_landed',
            'movement_not_executed',
            'chain_delta_matched',
            'chain_delta_mismatch'
        )
    ) NOT VALID;
