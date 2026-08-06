-- Native SOL rows historically recorded the literal 'SOL' in token columns
-- while SPL rows record the mint, so filtering and policy checks compared two
-- encodings of the same asset. normalizePaymentToken now canonicalizes native
-- SOL to the wrapped SOL mint (native-vs-SPL dispatch goes through
-- isNativePaymentToken, never mint equality); this backfills the legacy rows.
UPDATE payment_transfers
   SET token = 'So11111111111111111111111111111111111111112'
 WHERE token = 'SOL';

UPDATE payment_transfer_batches
   SET token = 'So11111111111111111111111111111111111111112'
 WHERE token = 'SOL';

UPDATE payment_recurring_payments
   SET token = 'So11111111111111111111111111111111111111112'
 WHERE token = 'SOL';
