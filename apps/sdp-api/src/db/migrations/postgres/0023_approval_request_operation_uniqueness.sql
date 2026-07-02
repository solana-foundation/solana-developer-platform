-- A paused wallet operation has one canonical SDP approval request.

WITH duplicate_approval_requests AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY wallet_operation_id
            ORDER BY created_at ASC, id ASC
        ) AS row_number
    FROM approval_requests
)
DELETE FROM approval_requests
WHERE id IN (
    SELECT id
    FROM duplicate_approval_requests
    WHERE row_number > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_operation_unique
    ON approval_requests(wallet_operation_id);
