-- Vault-direct deposits are on-chain program interactions. Migration 0058
-- narrowed the live wallet-operation vocabulary before this producer merged;
-- extend that constraint now that POST /v1/earn/vault-deposits emits `program`.
-- Keep the constraint NOT VALID so retired historical families remain readable.
ALTER TABLE wallet_operations
    DROP CONSTRAINT wallet_operations_family_check;

ALTER TABLE wallet_operations
    ADD CONSTRAINT wallet_operations_family_check
        CHECK (operation_family IN ('transfer', 'payment', 'ramp', 'issuance', 'program'))
        NOT VALID;
