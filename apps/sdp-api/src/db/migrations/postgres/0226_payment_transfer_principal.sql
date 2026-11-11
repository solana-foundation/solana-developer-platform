-- Record who initiated execution without inferring authority for legacy rows.
-- Nullable with no default so the previous application revision keeps writing.
ALTER TABLE payment_transfers
    ADD COLUMN initiated_by_principal JSONB;

-- Enforce the canonical MoneyPrincipal variants on new writes without scanning
-- payment history while this transaction holds the ALTER TABLE lock. The trim
-- characters match JavaScript String.trim(), which the canonical parser uses.
ALTER TABLE payment_transfers
    ADD CONSTRAINT payment_transfers_initiated_by_principal_check
    CHECK (
        initiated_by_principal IS NULL
        OR (
            CASE WHEN jsonb_typeof(initiated_by_principal) = 'object' THEN
                CASE initiated_by_principal->>'kind'
                    WHEN 'api_key' THEN
                        initiated_by_principal - ARRAY['kind', 'apiKeyId'] = '{}'::jsonb
                        AND jsonb_typeof(initiated_by_principal->'apiKeyId') = 'string'
                        AND btrim(
                            initiated_by_principal->>'apiKeyId',
                            U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003' ||
                            U&'\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
                        ) <> ''
                    WHEN 'member' THEN
                        initiated_by_principal - ARRAY['kind', 'userId'] = '{}'::jsonb
                        AND jsonb_typeof(initiated_by_principal->'userId') = 'string'
                        AND btrim(
                            initiated_by_principal->>'userId',
                            U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003' ||
                            U&'\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
                        ) <> ''
                    WHEN 'mandate' THEN
                        initiated_by_principal - ARRAY['kind', 'recurringPaymentId'] = '{}'::jsonb
                        AND jsonb_typeof(initiated_by_principal->'recurringPaymentId') = 'string'
                        AND btrim(
                            initiated_by_principal->>'recurringPaymentId',
                            U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003' ||
                            U&'\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
                        ) <> ''
                    WHEN 'payment_request' THEN
                        initiated_by_principal - ARRAY['kind', 'paymentRequestId'] = '{}'::jsonb
                        AND jsonb_typeof(initiated_by_principal->'paymentRequestId') = 'string'
                        AND btrim(
                            initiated_by_principal->>'paymentRequestId',
                            U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003' ||
                            U&'\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
                        ) <> ''
                    ELSE FALSE
                END
            ELSE FALSE END
        ) IS TRUE
    ) NOT VALID;
