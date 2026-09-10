-- Pins each Rings wallet to the key authority that provisioned it.
--
-- Shielded keys are not portable: a wallet's on-chain identity is derived from
-- its specific viewing and nullifier bytes, and the SDK re-derives and compares
-- that identity on every use. So the authority that created a wallet is the only
-- one that can ever serve it, and "which authority" is per-wallet state rather
-- than a deployment-wide setting. Flipping a global default would otherwise
-- strand every wallet provisioned before the flip.
--
-- 'deterministic' is the default precisely so existing rows keep working: they
-- were provisioned by the hardcoded-seed authority, and defaulting them to it
-- keeps their identities deriving as before. Only wallets created once the
-- deployment selects another authority are stored differently.

ALTER TABLE helius_rings_wallets
    ADD COLUMN IF NOT EXISTS key_authority TEXT NOT NULL DEFAULT 'deterministic';

-- Mirrors the shape of the material_tag and status CHECKs in 0057: the app
-- reads this column back into a TypeScript union, and the constraint is what
-- makes that cast honest rather than hopeful.
DO $$
BEGIN
    ALTER TABLE helius_rings_wallets
        ADD CONSTRAINT helius_rings_wallets_key_authority_check
            CHECK (key_authority IN ('deterministic', 'database'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

-- 0057 created helius_rings_key_refs and 0067 commented it as unused, because
-- the deterministic authority derives material per use and stores nothing. The
-- 'database' authority added alongside this migration writes it, so the comment
-- is now wrong. 0067 has already been applied, so this restates it rather than
-- editing the old file.
COMMENT ON TABLE helius_rings_key_refs IS
    'Sealed viewing and nullifier material for wallets whose key_authority is ''database''. Empty for ''deterministic'' wallets, which re-derive material from a seed and store nothing.';
