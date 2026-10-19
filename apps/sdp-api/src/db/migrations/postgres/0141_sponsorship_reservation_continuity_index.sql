-- sdp:migration-mode: non-transactional
-- Retained message evidence is read before an actor can choose a new reservation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sponsorship_reservations_continuity
  ON sponsorship_budget_reservations (organization_id, project_id, transaction_digest);
