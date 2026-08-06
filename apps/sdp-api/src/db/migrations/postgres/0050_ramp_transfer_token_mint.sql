-- Transfer token columns historically mixed two encodings: ramp rows recorded
-- the quoted crypto SYMBOL ('USDC') and native SOL rows recorded the literal
-- 'SOL', while SPL rows recorded the mint address — so filtering and policy
-- checks compared different encodings of the same asset. The write paths now
-- record the mint everywhere (native SOL canonicalizes to the wrapped SOL
-- mint; native-vs-SPL dispatch goes through isNativePaymentToken, never mint
-- equality); this backfills the legacy rows.
--
-- Every deployment is devnet today (pre-mainnet), so the devnet mints are the
-- correct targets; a future mainnet database replays this against zero rows.
-- USDT has no devnet mint, so no devnet row can carry it.
UPDATE payment_transfers
   SET token = 'So11111111111111111111111111111111111111112'
 WHERE token = 'SOL';

UPDATE payment_transfers
   SET token = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
 WHERE token = 'USDC';

UPDATE payment_transfers
   SET token = '4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7'
 WHERE token = 'USDG';

UPDATE payment_transfers
   SET token = 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM'
 WHERE token = 'PYUSD';

UPDATE payment_transfer_batches
   SET token = 'So11111111111111111111111111111111111111112'
 WHERE token = 'SOL';
