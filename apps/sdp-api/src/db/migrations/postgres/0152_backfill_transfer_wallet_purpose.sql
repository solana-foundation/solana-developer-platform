-- sdp:migration-compat: breaking
-- Deploy after the wallet-purpose enforcement in PR #2477. That revision
-- creates transfer wallets and still reads legacy root/null purposes.
-- Known risk: legacy wallets cannot fund payments or recurring collections
-- between the enforcement deployment and this backfill.
-- Root and unset purposes were legacy general-purpose wallets; preserve all
-- explicitly specialized purposes. Their old root/null distinction is lost.
UPDATE custody_wallets
   SET purpose = 'transfer', updated_at = sdp_iso_now()
 WHERE purpose = 'root' OR purpose IS NULL;
