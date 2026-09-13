import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { HeliusRingsAssetRepository } from "./helius-rings-asset.repository";
import { createPostgresHeliusRingsAssetRepository } from "./helius-rings-asset.repository.postgres";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DISABLED_MINT = "DisabledMint1111111111111111111111111111111";

describe("HeliusRingsAssetRepository (postgres)", () => {
  let repo: HeliusRingsAssetRepository;

  beforeEach(async () => {
    await seedTestDatabase(env);
    repo = createPostgresHeliusRingsAssetRepository(getDb(env));
  });

  // `helius_rings_asset_allowlist` is deliberately excluded from the per-test
  // TRUNCATE (see test/mocks/db.ts) because it is migration-seeded reference
  // data nothing re-seeds. That makes the disabled row below permanent for the
  // rest of the run, and 0057_helius_rings.migration.test.ts asserts the
  // allowlist holds exactly SOL and USDC — so whichever file its worker reached
  // second used to fail. This suite cleans up after itself instead.
  afterEach(async () => {
    await getDb(env)
      .prepare("DELETE FROM helius_rings_asset_allowlist WHERE mint = ?")
      .bind(DISABLED_MINT)
      .run();
  });

  it("returns the seeded SOL and USDC rows as active", async () => {
    await expect(repo.getActiveByMint(SOL_MINT)).resolves.toMatchObject({
      mint: SOL_MINT,
      symbol: "SOL",
      decimals: 9,
      status: "active",
    });
    await expect(repo.getActiveByMint(USDC_MINT)).resolves.toMatchObject({
      mint: USDC_MINT,
      symbol: "USDC",
      decimals: 6,
      status: "active",
    });
  });

  it("returns null for a mint that was never allowlisted", async () => {
    await expect(repo.getActiveByMint("not-a-mint")).resolves.toBeNull();
  });

  it("returns null for a mint that an operator has disabled", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO helius_rings_asset_allowlist (mint, symbol, decimals, status)
         VALUES (?, 'FAKE', 6, 'disabled')`
      )
      .bind(DISABLED_MINT)
      .run();

    await expect(repo.getActiveByMint(DISABLED_MINT)).resolves.toBeNull();
    expect((await repo.listActive()).map((row) => row.mint)).not.toContain(DISABLED_MINT);
  });
});
