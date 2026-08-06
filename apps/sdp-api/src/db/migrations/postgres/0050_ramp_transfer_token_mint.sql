-- Ramp transfers historically recorded the quoted crypto SYMBOL in token while
-- every other transfer row records the mint address, so ramp rows could not be
-- resolved against the token registry or issued-token metadata. The write path
-- now records the mint; this backfills the legacy symbol rows.
--
-- Every deployment is devnet today (pre-mainnet), so the devnet mints are the
-- correct targets; a future mainnet database replays this against zero rows.
-- USDT has no devnet mint, so no devnet row can carry it.
UPDATE payment_transfers
   SET token = 'So11111111111111111111111111111111111111112'
 WHERE token = 'SOL' AND type IN ('onramp', 'offramp');

UPDATE payment_transfers
   SET token = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
 WHERE token = 'USDC' AND type IN ('onramp', 'offramp');

UPDATE payment_transfers
   SET token = '4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7'
 WHERE token = 'USDG' AND type IN ('onramp', 'offramp');

UPDATE payment_transfers
   SET token = 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM'
 WHERE token = 'PYUSD' AND type IN ('onramp', 'offramp');
