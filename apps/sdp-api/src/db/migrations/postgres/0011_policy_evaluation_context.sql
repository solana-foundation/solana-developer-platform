-- Store the normalized operation/policy snapshot used by the evaluator so
-- audit readers do not need to infer context from mutable surrounding records.

ALTER TABLE policy_evaluations
    ADD COLUMN IF NOT EXISTS evaluation_context JSONB;
