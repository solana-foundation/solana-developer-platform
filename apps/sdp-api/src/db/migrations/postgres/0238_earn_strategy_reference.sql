-- Expand only. These generic references can name a lending market or RWA
-- mint as well as a vault. Retain vault_address for the serving/previous image.
-- Old rows read through COALESCE until a later bounded backfill; no full-table
-- rewrite or destructive rename runs while the previous revision is serving.
ALTER TABLE earn_positions ADD COLUMN strategy_reference TEXT;
ALTER TABLE earn_movements ADD COLUMN strategy_reference TEXT;
ALTER TABLE earn_external_wallet_transactions ADD COLUMN strategy_reference TEXT;

CREATE FUNCTION sync_earn_strategy_reference() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.strategy_reference IS DISTINCT FROM OLD.strategy_reference
      AND NEW.vault_address IS NOT DISTINCT FROM OLD.vault_address THEN
      NEW.vault_address := NEW.strategy_reference;
    ELSIF NEW.vault_address IS DISTINCT FROM OLD.vault_address
      AND NEW.strategy_reference IS NOT DISTINCT FROM OLD.strategy_reference THEN
      NEW.strategy_reference := NEW.vault_address;
    END IF;
  END IF;
  NEW.strategy_reference := COALESCE(NEW.strategy_reference, NEW.vault_address);
  NEW.vault_address := COALESCE(NEW.vault_address, NEW.strategy_reference);
  IF NEW.strategy_reference IS DISTINCT FROM NEW.vault_address THEN
    RAISE EXCEPTION 'Earn strategy reference conflicts with legacy reference';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER earn_positions_strategy_reference
BEFORE INSERT OR UPDATE ON earn_positions
FOR EACH ROW EXECUTE FUNCTION sync_earn_strategy_reference();
CREATE TRIGGER earn_movements_strategy_reference
BEFORE INSERT OR UPDATE ON earn_movements
FOR EACH ROW EXECUTE FUNCTION sync_earn_strategy_reference();
CREATE TRIGGER earn_transactions_strategy_reference
BEFORE INSERT OR UPDATE ON earn_external_wallet_transactions
FOR EACH ROW EXECUTE FUNCTION sync_earn_strategy_reference();
