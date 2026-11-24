-- Validate separately so the adding transaction releases its DDL lock first.
ALTER TABLE earn_positions VALIDATE CONSTRAINT earn_positions_strategy_fk;
