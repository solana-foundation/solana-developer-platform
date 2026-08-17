-- Signer checks are no longer wallet operations; their historical raw_sign
-- rows (and cascaded approvals/evaluations) would fail the tightened CHECK,
-- which validates existing rows on ADD CONSTRAINT.
DELETE FROM wallet_operations
    WHERE operation_family NOT IN ('transfer', 'payment', 'ramp', 'issuance');

ALTER TABLE wallet_operations
    DROP CONSTRAINT wallet_operations_family_check;

ALTER TABLE wallet_operations
    ADD CONSTRAINT wallet_operations_family_check
        CHECK (operation_family IN ('transfer', 'payment', 'ramp', 'issuance'));
