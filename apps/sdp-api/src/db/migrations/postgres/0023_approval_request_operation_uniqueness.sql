-- A paused wallet operation has one canonical SDP approval request.

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_operation_unique
    ON approval_requests(wallet_operation_id);
