-- Allowed Operations (ADR 0006): the Helius Rings family is `privacy`, not
-- `transfer`. Rewrites any key stored with the old value. Kept sorted, deduped
-- and compact so it matches what the API writes. A key the rewrite misses
-- fails closed: `transfer` matches nothing, and the list is still non-empty.
UPDATE api_keys
SET allowed_operations = (
  SELECT '[' || string_agg(to_json(v)::text, ',' ORDER BY v COLLATE "C") || ']'
  FROM (
    SELECT DISTINCT CASE WHEN e = 'transfer' THEN 'privacy' ELSE e END AS v
    FROM jsonb_array_elements_text(allowed_operations::jsonb) AS t(e)
  ) AS renamed
)
WHERE allowed_operations IS NOT NULL
  AND allowed_operations::jsonb ? 'transfer';
