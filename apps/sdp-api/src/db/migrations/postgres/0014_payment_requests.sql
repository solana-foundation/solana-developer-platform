-- Onchain payment requests (Solana Pay). A request is an *ask* — fixed-amount,
-- single-use — tracked from creation to settlement via its Solana Pay `reference`.
-- Money still lives in payment_transfers; a paid request links the settling row
-- through fulfilled_by_transfer_id. Status is the request's business state; the
-- on-chain settlement detail rides the linked transfer.

CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    counterparty_id TEXT,
    wallet_id TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'awaiting_payment',
    expires_at TEXT,
    fulfilled_by_transfer_id TEXT,
    canceled_by TEXT,
    lifecycle JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (counterparty_id, organization_id, project_id)
        REFERENCES counterparties(id, organization_id, project_id),
    FOREIGN KEY (fulfilled_by_transfer_id) REFERENCES payment_transfers(id),
    CONSTRAINT payment_requests_status_check
        CHECK (status IN ('awaiting_payment', 'paid', 'canceled', 'expired')),
    CONSTRAINT payment_requests_lifecycle_is_array
        CHECK (jsonb_typeof(lifecycle) = 'array'),
    CONSTRAINT payment_requests_canceled_by_only_when_canceled
        CHECK (canceled_by IS NULL OR status = 'canceled'),
    CONSTRAINT payment_requests_paid_requires_transfer
        CHECK (status != 'paid' OR fulfilled_by_transfer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_project_created
    ON payment_requests(organization_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_requests_awaiting
    ON payment_requests(expires_at)
    WHERE status = 'awaiting_payment';
