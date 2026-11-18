-- Discovering a holding proves its live balance, never its acquisition cost.
-- Existing tracked holdings retain their historical accounting behavior. A
-- signed discovery claim marks the basis unknown permanently, including after
-- a later SDP deposit, so outside principal cannot become reported earnings.
ALTER TABLE earn_positions
  ADD COLUMN cost_basis_known BOOLEAN NOT NULL DEFAULT TRUE;
