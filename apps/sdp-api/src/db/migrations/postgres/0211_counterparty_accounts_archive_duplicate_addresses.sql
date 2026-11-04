-- sdp:migration-compat: breaking
-- HOO-2618: one counterparty could hold two active crypto_wallet accounts with
-- the same network and address, and Pay → Destination listed both. 0212 builds
-- a unique index over active accounts; this archives the duplicates it would
-- reject first, keeping the oldest account for each address.
--
-- Breaking only by the compatibility check's definition (it rewrites existing
-- rows): the previous revision reads archived accounts already, and archiving
-- is the same transition DELETE /v1/counterparties/{id}/accounts/{accountId}
-- makes. A recurring payment paying an archived account pauses with
-- `destination_unavailable` at its next collection (0208).
--
-- Older rows keep the address only in `details`, so the key reads the column
-- and falls back to the JSON, as 0212's index does.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY counterparty_id,
                            COALESCE(network, details->>'network'),
                            COALESCE(address, details->>'address')
               ORDER BY created_at ASC, id ASC
           ) AS position
      FROM counterparty_accounts
     WHERE status = 'active'
       AND account_kind = 'crypto_wallet'
       AND COALESCE(address, details->>'address') IS NOT NULL
)
UPDATE counterparty_accounts
   SET status = 'archived',
       updated_at = sdp_iso_now()
 WHERE id IN (SELECT id FROM ranked WHERE position > 1);
