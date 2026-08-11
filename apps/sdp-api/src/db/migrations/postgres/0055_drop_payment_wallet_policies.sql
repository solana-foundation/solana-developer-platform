-- 0055_drop_payment_wallet_policies.sql
--
-- Drops the legacy payment_wallet_policies table (PRO-1617). Wallet control
-- profiles (0010_wallet_api_key_policy_foundations.sql) are the only policy
-- engine; legacy rows are not converted — pre-mainnet, operators re-author
-- policies as control-profile rules.

DROP TABLE IF EXISTS payment_wallet_policies;
