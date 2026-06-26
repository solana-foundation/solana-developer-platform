-- Some local/preview databases applied an earlier activation-attempt migration
-- that used `phase` instead of `stage`. The runtime now reads/writes `stage`,
-- so make the current table shape compatible without depending on a re-run of
-- 0015.

DO $$
BEGIN
  IF to_regclass('payment_recurring_payment_activation_attempts') IS NOT NULL THEN
    ALTER TABLE payment_recurring_payment_activation_attempts
      ADD COLUMN IF NOT EXISTS stage TEXT;

    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'payment_recurring_payment_activation_attempts'
         AND column_name = 'phase'
    ) THEN
      UPDATE payment_recurring_payment_activation_attempts
         SET stage = COALESCE(stage, phase, 'claim')
       WHERE stage IS NULL;
    ELSE
      UPDATE payment_recurring_payment_activation_attempts
         SET stage = COALESCE(stage, 'claim')
       WHERE stage IS NULL;
    END IF;

    ALTER TABLE payment_recurring_payment_activation_attempts
      ALTER COLUMN stage SET DEFAULT 'claim',
      ALTER COLUMN stage SET NOT NULL;

    UPDATE payment_recurring_payment_activation_attempts
       SET stage = 'claim'
     WHERE stage NOT IN ('claim', 'create_plan', 'authorize_subscription', 'finalize');

    ALTER TABLE payment_recurring_payment_activation_attempts
      DROP CONSTRAINT IF EXISTS payment_recurring_payment_activation_attempts_stage_check;

    ALTER TABLE payment_recurring_payment_activation_attempts
      ADD CONSTRAINT payment_recurring_payment_activation_attempts_stage_check
        CHECK (stage IN ('claim', 'create_plan', 'authorize_subscription', 'finalize'));
  END IF;
END $$;
