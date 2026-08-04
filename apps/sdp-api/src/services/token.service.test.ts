/**
 * Token Service Unit Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type PreparedStatement } from "@/db";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { TokenService } from "@/services/token.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT, TEST_PROJECT_API_KEY } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

describe("TokenService", () => {
  let db: DatabaseClient;
  let tokenService: TokenService;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    db = getDb(env);
    tokenService = new TokenService(db);

    await db
      .prepare("DELETE FROM frozen_accounts")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issued_tokens")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM users")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM organizations")
      .run()
      .catch(() => {});

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_PROJECT.organizationId,
        TEST_PROJECT.name,
        TEST_PROJECT.slug,
        TEST_PROJECT.environment,
        TEST_PROJECT.status,
        TEST_PROJECT.createdBy
      )
      .run();

    await db
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Project Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        TEST_PROJECT_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_PROJECT_API_KEY.prefix,
        "hash_unused_for_service_test"
      )
      .run();

    await db
      .prepare(
        `INSERT INTO issued_tokens (
          id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
          name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled,
          allowlist_enabled, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'Freezable Token', 'FRZ', 9, '0', 1, 1, 0, 'active', ?)`
      )
      .bind(
        "tok_freeze_refreeze",
        TEST_PROJECT.id,
        TEST_ORG.id,
        "So11111111111111111111111111111111111111112",
        "AENLi9e2xTiK7YHThmEQhBrCaDTjTRV4hsDXdwbPcBbxK9",
        "73ScTjQ3uVNHGF36yoaseFCVUYEoLhZwxvJ9z7CVseod",
        TEST_PROJECT_API_KEY.id
      )
      .run();
  });

  it("reuses the existing frozen-account row after unfreeze", async () => {
    const firstFreeze = await tokenService.freezeAccount({
      tokenId: "tok_freeze_refreeze",
      accountAddress: "wallet_owner_1",
      frozenBy: TEST_USER.id,
      reason: "Initial freeze",
    });

    const thawed = await tokenService.unfreezeAccount(
      "tok_freeze_refreeze",
      "wallet_owner_1",
      TEST_USER.id
    );

    expect(thawed.unfrozenAt).not.toBeNull();

    const secondFreeze = await tokenService.freezeAccount({
      tokenId: "tok_freeze_refreeze",
      accountAddress: "wallet_owner_1",
      frozenBy: TEST_USER.id,
      reason: "Frozen again",
    });

    expect(secondFreeze.id).toBe(firstFreeze.id);
    expect(secondFreeze.reason).toBe("Frozen again");
    expect(secondFreeze.unfrozenAt).toBeNull();

    const storedRows = await db
      .prepare(
        `SELECT id, reason, unfrozen_at
         FROM frozen_accounts
         WHERE token_id = ? AND account_address = ?`
      )
      .bind("tok_freeze_refreeze", "wallet_owner_1")
      .all<{ id: string; reason: string | null; unfrozen_at: string | null }>();

    expect(storedRows.results).toHaveLength(1);
    expect(storedRows.results[0]?.id).toBe(firstFreeze.id);
    expect(storedRows.results[0]?.reason).toBe("Frozen again");
    expect(storedRows.results[0]?.unfrozen_at).toBeNull();
  });

  describe("createToken maxSupply precision", () => {
    const baseInput = {
      projectId: TEST_PROJECT.id,
      organizationId: TEST_ORG.id,
      createdBy: TEST_PROJECT_API_KEY.id,
      name: "Capped Token",
      symbol: "CAP",
    };

    it("stores a cap whose precision fits the token's decimals", async () => {
      const token = await tokenService.createToken({
        ...baseInput,
        decimals: 2,
        maxSupply: "1000.25",
      });

      expect(token.maxSupply).toBe("1000.25");
    });

    it("rejects a cap with more decimal places than the mint can represent", async () => {
      // parseDecimalAmount throws AmountError on excess scale. Unguarded that
      // escaped as a 500; it must surface as a 400 instead, because the effective
      // decimals are only known here (a template may override what was requested).
      await expect(
        tokenService.createToken({ ...baseInput, decimals: 0, maxSupply: "1.5" })
      ).rejects.toThrow(AppError);

      await expect(
        tokenService.createToken({ ...baseInput, decimals: 0, maxSupply: "1.5" })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("treats an absent cap as uncapped", async () => {
      const token = await tokenService.createToken({ ...baseInput, decimals: 6 });

      expect(token.maxSupply).toBeNull();
      // Unchanged defaults — the mint stays mintable and freezable.
      expect(token.isMintable).toBe(true);
      expect(token.isFreezable).toBe(true);
    });

    it("persists isFreezable: false so deploy omits the freeze authority", async () => {
      const token = await tokenService.createToken({
        ...baseInput,
        decimals: 6,
        isFreezable: false,
      });

      expect(token.isFreezable).toBe(false);

      // Round-trip through the DB: deploy reads the persisted row, not this object.
      const reloaded = await tokenService.getToken({
        tokenId: token.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
      expect(reloaded?.isFreezable).toBe(false);
    });
  });

  describe("updateToken undeployed guard", () => {
    async function insertToken(
      id: string,
      overrides: { mintAddress?: string | null; projectId?: string; status?: string }
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO issued_tokens (
            id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
            name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled,
            allowlist_enabled, status, created_by
          ) VALUES (?, ?, ?, ?, NULL, NULL, 'Guarded Token', 'GRD', 9, '0', 1, 1, 0, ?, ?)`
        )
        .bind(
          id,
          overrides.projectId ?? TEST_PROJECT.id,
          TEST_ORG.id,
          overrides.mintAddress ?? null,
          overrides.status ?? "pending",
          TEST_PROJECT_API_KEY.id
        )
        .run();
    }

    it("applies symbol/decimals changes while the token is an undeployed draft", async () => {
      await insertToken("tok_guard_pending", { status: "pending", mintAddress: null });

      const updated = await tokenService.updateToken("tok_guard_pending", {
        symbol: "RENAMED",
        decimals: 2,
      });

      expect(updated.symbol).toBe("RENAMED");
      expect(updated.decimals).toBe(2);
    });

    it("refuses symbol/decimals changes once the token is deployed (optimistic lock)", async () => {
      // Simulates a deploy landing between the handler's guard read and this
      // write: the row is active with a mint by the time the UPDATE runs.
      await insertToken("tok_guard_deployed", {
        status: "active",
        mintAddress: "Dep1oyed11111111111111111111111111111111111",
      });

      await expect(
        tokenService.updateToken("tok_guard_deployed", { symbol: "RENAMED", decimals: 2 })
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const row = await db
        .prepare("SELECT symbol, decimals FROM issued_tokens WHERE id = ?")
        .bind("tok_guard_deployed")
        .first<{ symbol: string; decimals: number }>();
      expect(row?.symbol).toBe("GRD");
      expect(row?.decimals).toBe(9);
    });

    it("still allows metadata (name) changes on a deployed token", async () => {
      await insertToken("tok_guard_metadata", {
        status: "active",
        mintAddress: "Metadata111111111111111111111111111111111111",
      });

      const updated = await tokenService.updateToken("tok_guard_metadata", {
        name: "New Display Name",
      });

      expect(updated.name).toBe("New Display Name");
    });

    it("throws a plain not-found error for a missing token", async () => {
      await expect(
        tokenService.updateToken("tok_does_not_exist", { name: "Nope" })
      ).rejects.toThrow("TOKEN_NOT_FOUND");
      await expect(
        tokenService.updateToken("tok_does_not_exist", { name: "Nope" })
      ).rejects.not.toBeInstanceOf(AppError);
    });
  });

  describe("maxSupply concurrency", () => {
    // A deployed, still-mintable token: cap and minted supply in base units.
    async function insertCappedToken(
      id: string,
      supplyBaseUnits: string,
      maxSupplyBaseUnits: string | null
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO issued_tokens (
            id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
            name, symbol, decimals, total_supply_cached, max_supply, is_mintable,
            freeze_authority_enabled, allowlist_enabled, status, created_by
          ) VALUES (?, ?, ?, 'Capped11111111111111111111111111111111111111', 'Auth111111111111111111111111111111111111111',
            NULL, 'Capped Token', 'CAP', 6, ?, ?, 1, 1, 0, 'active', ?)`
        )
        .bind(
          id,
          TEST_PROJECT.id,
          TEST_ORG.id,
          supplyBaseUnits,
          maxSupplyBaseUnits,
          TEST_PROJECT_API_KEY.id
        )
        .run();
    }

    const storedSupply = (id: string) =>
      db
        .prepare(
          "SELECT total_supply_cached, total_supply_updated_at, max_supply FROM issued_tokens WHERE id = ?"
        )
        .bind(id)
        .first<{
          total_supply_cached: string;
          total_supply_updated_at: string | null;
          max_supply: string | null;
        }>();

    it("admits concurrent mints only up to the cap", async () => {
      // The check each handler makes against its own read of the cached supply
      // passes for both of these; the reservation is the same row twice, so the
      // database has to pick one.
      await insertCappedToken("tok_cap_concurrent", "0", "1000000000");

      const reservations = await Promise.all([
        tokenService.reserveMintSupply("tok_cap_concurrent", "600000000"),
        tokenService.reserveMintSupply("tok_cap_concurrent", "600000000"),
      ]);

      expect(reservations.filter((value) => value !== null)).toHaveLength(1);
      expect((await storedSupply("tok_cap_concurrent"))?.total_supply_cached).toBe("600000000");
    });

    it("counts every concurrent reservation that fits", async () => {
      // Read-modify-write lost one of each concurrent pair here, and the cache
      // stayed short for good — which then let admission pass mints the cap should
      // have refused. Ten at once must add up to exactly ten.
      await insertCappedToken("tok_cap_no_lost_update", "0", "1000000000");

      const reservations = await Promise.all(
        Array.from({ length: 10 }, () =>
          tokenService.reserveMintSupply("tok_cap_no_lost_update", "100000000")
        )
      );

      expect(reservations.every((value) => value !== null)).toBe(true);
      expect((await storedSupply("tok_cap_no_lost_update"))?.total_supply_cached).toBe(
        "1000000000"
      );
    });

    it("reserves without limit when the token has no cap", async () => {
      await insertCappedToken("tok_cap_uncapped", "5", null);

      await expect(
        tokenService.reserveMintSupply("tok_cap_uncapped", "999999999999")
      ).resolves.toBe("1000000000004");
    });

    it("will not let a refresh erase a reservation the chain cannot see yet", async () => {
      // The window the mint account is blind to: reserved, sent, not settled. An
      // overwrite here would put the record back to 0 and hand the same 600 of
      // headroom to the next mint, and both would land above the cap.
      await insertCappedToken("tok_cap_refresh_inflight", "0", "1000000000");
      await tokenService.reserveMintSupply("tok_cap_refresh_inflight", "600000000");
      await insertMintTransaction("tok_cap_refresh_inflight", "pending", {
        prepared: false,
        amount: "600",
      });
      const before = await storedSupply("tok_cap_refresh_inflight");

      await tokenService.setSupplyFromBaseUnits("tok_cap_refresh_inflight", "0");

      const row = await storedSupply("tok_cap_refresh_inflight");
      expect(row?.total_supply_cached).toBe("600000000");
      // The reading was not taken, so its "as of" stamp does not move either.
      expect(row?.total_supply_updated_at).toBe(before?.total_supply_updated_at);
      await expect(
        tokenService.reserveMintSupply("tok_cap_refresh_inflight", "600000000")
      ).resolves.toBeNull();
    });

    it("holds the reservation of a mint that failed ambiguously", async () => {
      // A send that times out during confirmation is recorded as failed while the
      // cluster may still accept it, so its row keeps counting until it cannot.
      await insertCappedToken("tok_cap_refresh_failed", "0", "1000000000");
      await tokenService.reserveMintSupply("tok_cap_refresh_failed", "600000000");
      await insertMintTransaction("tok_cap_refresh_failed", "failed", {
        prepared: false,
        amount: "600",
      });

      await tokenService.setSupplyFromBaseUnits("tok_cap_refresh_failed", "0");

      expect((await storedSupply("tok_cap_refresh_failed"))?.total_supply_cached).toBe("600000000");
    });

    it("reconciles down once the mint can no longer land", async () => {
      // Past the blockhash's life the question is settled: the mint account is the
      // whole truth, so the headroom a never-submitted mint held comes back.
      await insertCappedToken("tok_cap_refresh_expired", "0", "1000000000");
      await tokenService.reserveMintSupply("tok_cap_refresh_expired", "600000000");
      await insertMintTransaction("tok_cap_refresh_expired", "pending", {
        prepared: false,
        ageMs: 10 * 60 * 1000,
      });

      const refreshed = await tokenService.setSupplyFromBaseUnits("tok_cap_refresh_expired", "0");

      expect(refreshed.totalSupply).toBe("0");
      expect(
        (await storedSupply("tok_cap_refresh_expired"))?.total_supply_updated_at
      ).not.toBeNull();
      await expect(
        tokenService.reserveMintSupply("tok_cap_refresh_expired", "1000000000")
      ).resolves.not.toBeNull();
    });

    it("reclaims an abandoned reservation even while newer mints are in flight", async () => {
      // The leak: an abandoned 900k reservation whose transaction expired long ago,
      // and a live 10-token mint keeping the token busy. A hold that asks only
      // "is anything in flight?" never reopens on a busy token, so the 900k stays
      // recorded forever and minting is denied at the cap for supply that does not
      // exist. What a refresh must protect is a quantity, not a flag: the chain
      // total plus what live mints could still add — here 0 + 10 tokens — and
      // everything recorded above that line is reclaimable now.
      await insertCappedToken("tok_cap_refresh_leak", "900010000000", "1000000000000");
      await insertMintTransaction("tok_cap_refresh_leak", "pending", {
        amount: "900000",
        ageMs: 10 * 60 * 1000,
      });
      await insertMintTransaction("tok_cap_refresh_leak", "pending", { amount: "10" });

      await tokenService.setSupplyFromBaseUnits("tok_cap_refresh_leak", "0");

      const row = await storedSupply("tok_cap_refresh_leak");
      // The live mint's 10 tokens are still protected; the abandoned 900k is gone.
      expect(row?.total_supply_cached).toBe("10000000");
      // And the headroom the leak was holding is mintable again.
      await expect(
        tokenService.reserveMintSupply("tok_cap_refresh_leak", "990000000000")
      ).resolves.not.toBeNull();
    });

    it("takes a higher on-chain total even while a mint is in flight", async () => {
      // Only the downward half waits. Supply above what SDP counted came from
      // outside SDP, and the cap has to start refusing against it immediately.
      await insertCappedToken("tok_cap_refresh_higher", "600000000", "2000000000");
      await insertMintTransaction("tok_cap_refresh_higher", "pending", { prepared: false });

      await tokenService.setSupplyFromBaseUnits("tok_cap_refresh_higher", "1500000000");

      expect((await storedSupply("tok_cap_refresh_higher"))?.total_supply_cached).toBe(
        "1500000000"
      );
    });

    it("says so when a refresh finds more supply on-chain than the cap allows", async () => {
      // Reservations keep SDP's own mints under the cap, so this means supply came
      // from somewhere SDP does not admit — an authority used outside the platform,
      // or a prepared transaction submitted after its cap was lowered.
      await insertCappedToken("tok_cap_refresh_over", "0", "1000000000");
      const warn = vi.spyOn(getLogger(), "warn");

      try {
        await tokenService.setSupplyFromBaseUnits("tok_cap_refresh_over", "1500000000");

        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "token_supply_exceeds_max_supply",
            tokenId: "tok_cap_refresh_over",
            onChainSupplyBaseUnits: "1500000000",
            maxSupplyBaseUnits: "1000000000",
          }),
          expect.any(String)
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("records a settled burn rather than a negative supply", async () => {
      // The on-chain balance check is what bounds a burn; a cached total that
      // already lagged reality is not a reason to reject the write.
      await insertCappedToken("tok_cap_settled_burn", "100000000", null);

      await expect(
        tokenService.updateSupply("tok_cap_settled_burn", "500", "burn")
      ).resolves.toBeUndefined();

      expect((await storedSupply("tok_cap_settled_burn"))?.total_supply_cached).toBe("0");
    });

    it("refuses a cap that a mint outran between the check and the write", async () => {
      await insertCappedToken("tok_cap_lost_race", "500000000", "1000000000");
      const originalPrepare = db.prepare.bind(db);

      // Lands the mint inside the window the guard exists for: after the cap has
      // been checked against the stored supply, before the new cap is written. A
      // 1200 cap is legal against 500 minted and illegal against the 1500 this
      // leaves behind, so an unguarded write would persist a cap the token has
      // already outgrown.
      let injected = false;
      db.prepare = ((query: string) => {
        const statement = originalPrepare(query);
        if (injected || !query.includes("COALESCE(total_supply_cached")) {
          return statement;
        }
        injected = true;
        return {
          ...statement,
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              ...bound,
              first: async (columnName?: string) => {
                const result = await bound.first(columnName);
                await originalPrepare(
                  "UPDATE issued_tokens SET total_supply_cached = ? WHERE id = ?"
                )
                  .bind("1500000000", "tok_cap_lost_race")
                  .run();
                return result;
              },
            } as PreparedStatement;
          },
        } as PreparedStatement;
      }) as typeof db.prepare;

      try {
        await expect(
          tokenService.updateToken("tok_cap_lost_race", { maxSupply: "1200" })
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message: expect.stringContaining("supply changed while this update was in flight"),
        });
      } finally {
        db.prepare = originalPrepare as typeof db.prepare;
      }

      expect(injected, "supply read was intercepted").toBe(true);
      // The cap the race would have persisted is not there, and the mint is.
      const row = await storedSupply("tok_cap_lost_race");
      expect(row?.max_supply).toBe("1000000000");
      expect(row?.total_supply_cached).toBe("1500000000");
    });

    // A mint transaction row. `prepared` is what `POST /mint/prepare` leaves
    // behind: a serialized transaction handed to a client who may submit it at any
    // point until its blockhash expires. `amount` is the decimal amount the real
    // handlers always store in the row's params — it is what tells the refresh how
    // much this mint could still add to the chain.
    async function insertMintTransaction(
      tokenId: string,
      status: "pending" | "confirmed" | "failed",
      {
        prepared = true,
        ageMs = 0,
        amount,
      }: { prepared?: boolean; ageMs?: number; amount?: string } = {}
    ): Promise<void> {
      const at = new Date(Date.now() - ageMs).toISOString();
      await db
        .prepare(
          `INSERT INTO issuance_transactions (
            id, token_id, organization_id, type, status, serialized_tx, operation_params,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'mint', ?, ?, ?, ?, ?)`
        )
        .bind(
          `txn_${tokenId}_${status}_${prepared ? "prepared" : "executed"}_${ageMs}`,
          tokenId,
          TEST_ORG.id,
          status,
          prepared ? "c2VyaWFsaXplZA==" : null,
          JSON.stringify(amount === undefined ? {} : { amount }),
          at,
          at
        )
        .run();
    }

    it("protects an outstanding prepared mint through its reservation", async () => {
      // A prepared mint is reserved before the serialized transaction leaves SDP,
      // so the cap change needs no knowledge of its row: the reservation is in the
      // recorded supply, and the "not below the already-minted supply" check reads
      // it there. 500 settled + 600 reserved = 1100, so a cap of 1000 undercuts the
      // mint the client may still submit.
      await insertCappedToken("tok_cap_prepared_reserved", "500000000", "2000000000");
      await tokenService.reserveMintSupply("tok_cap_prepared_reserved", "600000000");
      await insertMintTransaction("tok_cap_prepared_reserved", "pending");

      await expect(
        tokenService.updateToken("tok_cap_prepared_reserved", { maxSupply: "1000" })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("already-minted supply"),
      });

      expect((await storedSupply("tok_cap_prepared_reserved"))?.max_supply).toBe("2000000000");
    });

    it("lets the cap change over an outstanding prepared mint it does not undercut", async () => {
      // The old marker check refused every cap edit for the length of the window,
      // whether or not the edit conflicted with anything. Room for the reservation
      // is the actual requirement: 500 + 600 fit under 1200.
      await insertCappedToken("tok_cap_prepared_fits", "500000000", "2000000000");
      await tokenService.reserveMintSupply("tok_cap_prepared_fits", "600000000");
      await insertMintTransaction("tok_cap_prepared_fits", "pending");

      const updated = await tokenService.updateToken("tok_cap_prepared_fits", {
        maxSupply: "1200",
      });

      expect(updated.maxSupply).toBe("1200");
    });

    it("does not gate the cap on transaction rows, settled or executing", async () => {
      // Every admitted mint lives in the recorded supply — an executing mint since
      // its pre-submission reservation, a settled one for good. Its rows carry no
      // extra information for the cap, so they must not block the edit.
      await insertCappedToken("tok_cap_rows_ignored", "500000000", "2000000000");
      await insertMintTransaction("tok_cap_rows_ignored", "confirmed");
      await insertMintTransaction("tok_cap_rows_ignored", "failed");
      await insertMintTransaction("tok_cap_rows_ignored", "pending", { prepared: false });

      const updated = await tokenService.updateToken("tok_cap_rows_ignored", {
        maxSupply: "1000",
      });

      expect(updated.maxSupply).toBe("1000");
    });

    it("does not guard an uncapping request on the supply", async () => {
      // Clearing a cap cannot conflict with a mint, so a supply that moved in the
      // window is not a reason to make the operator retry.
      await insertCappedToken("tok_cap_cleared", "500000000", "1000000000");

      const updated = await tokenService.updateToken("tok_cap_cleared", { maxSupply: null });

      expect(updated.maxSupply).toBeNull();
      expect((await storedSupply("tok_cap_cleared"))?.max_supply).toBeNull();
    });
  });

  describe("deploy claim lifecycle (beginTokenDeploy / releaseTokenDeploy)", () => {
    async function insertToken(
      id: string,
      overrides: { mintAddress?: string | null; projectId?: string; status?: string }
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO issued_tokens (
            id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
            name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled,
            allowlist_enabled, status, created_by
          ) VALUES (?, ?, ?, ?, NULL, NULL, 'Claimed Token', 'CLM', 9, '0', 1, 1, 0, ?, ?)`
        )
        .bind(
          id,
          overrides.projectId ?? TEST_PROJECT.id,
          TEST_ORG.id,
          overrides.mintAddress ?? null,
          overrides.status ?? "pending",
          TEST_PROJECT_API_KEY.id
        )
        .run();
    }

    async function readStatus(id: string): Promise<string | undefined> {
      const row = await db
        .prepare("SELECT status FROM issued_tokens WHERE id = ?")
        .bind(id)
        .first<{ status: string }>();
      return row?.status;
    }

    it("claims a pending token, flipping it to deploying and returning the frozen snapshot", async () => {
      await insertToken("tok_claim_ok", { status: "pending", mintAddress: null });

      const claimed = await tokenService.beginTokenDeploy("tok_claim_ok");

      expect(claimed).not.toBeNull();
      expect(claimed?.symbol).toBe("CLM");
      expect(await readStatus("tok_claim_ok")).toBe("deploying");
    });

    it("returns null when the token is already claimed for deploy", async () => {
      await insertToken("tok_claim_twice", { status: "pending", mintAddress: null });

      expect(await tokenService.beginTokenDeploy("tok_claim_twice")).not.toBeNull();
      // A second, concurrent deploy must lose the claim rather than mint twice.
      expect(await tokenService.beginTokenDeploy("tok_claim_twice")).toBeNull();
    });

    it("returns null for an already-deployed token", async () => {
      await insertToken("tok_claim_deployed", {
        status: "active",
        mintAddress: "Dep1oyed11111111111111111111111111111111111",
      });

      expect(await tokenService.beginTokenDeploy("tok_claim_deployed")).toBeNull();
      expect(await readStatus("tok_claim_deployed")).toBe("active");
    });

    it("blocks symbol/decimals PATCHes while the token is deploying (closes the stale-snapshot race)", async () => {
      await insertToken("tok_claim_race", { status: "pending", mintAddress: null });
      await tokenService.beginTokenDeploy("tok_claim_race");

      // This is the exact race: a PATCH landing while the mint is being created
      // from the claimed snapshot must lose, not corrupt the identity.
      await expect(
        tokenService.updateToken("tok_claim_race", { symbol: "RACED", decimals: 2 })
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const row = await db
        .prepare("SELECT symbol, decimals FROM issued_tokens WHERE id = ?")
        .bind("tok_claim_race")
        .first<{ symbol: string; decimals: number }>();
      expect(row?.symbol).toBe("CLM");
      expect(row?.decimals).toBe(9);
    });

    it("blocks metadata updates while deployment is using the claimed snapshot", async () => {
      await insertToken("tok_claim_metadata_race", { status: "pending", mintAddress: null });
      await tokenService.beginTokenDeploy("tok_claim_metadata_race");

      await expect(
        tokenService.updateToken("tok_claim_metadata_race", {
          name: "Divergent metadata",
          description: "Must not persist while deployment is in flight",
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const row = await db
        .prepare("SELECT name, description FROM issued_tokens WHERE id = ?")
        .bind("tok_claim_metadata_race")
        .first<{ name: string; description: string | null }>();
      expect(row).toEqual({ name: "Claimed Token", description: null });
    });

    it("blocks stale metadata updates after deployment completes", async () => {
      await insertToken("tok_completed_metadata_race", { status: "pending", mintAddress: null });
      const pendingSnapshot = await tokenService.getToken({
        tokenId: "tok_completed_metadata_race",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
      expect(pendingSnapshot).not.toBeNull();

      await tokenService.beginTokenDeploy("tok_completed_metadata_race");
      await tokenService.setTokenDeployed(
        "tok_completed_metadata_race",
        "11111111111111111111111111111111",
        "11111111111111111111111111111111",
        null
      );

      await expect(
        tokenService.updateToken(
          "tok_completed_metadata_race",
          { name: "Stale route snapshot" },
          {
            status: pendingSnapshot?.status ?? "pending",
            mintAddress: pendingSnapshot?.mintAddress ?? null,
          }
        )
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const row = await db
        .prepare("SELECT name FROM issued_tokens WHERE id = ?")
        .bind("tok_completed_metadata_race")
        .first<{ name: string }>();
      expect(row?.name).toBe("Claimed Token");
    });

    it("releases a deploying claim back to pending so a failed deploy stays editable", async () => {
      await insertToken("tok_claim_release", { status: "pending", mintAddress: null });
      await tokenService.beginTokenDeploy("tok_claim_release");
      expect(await readStatus("tok_claim_release")).toBe("deploying");

      await tokenService.releaseTokenDeploy("tok_claim_release");
      expect(await readStatus("tok_claim_release")).toBe("pending");

      // Editable again after release.
      const updated = await tokenService.updateToken("tok_claim_release", { symbol: "REDO" });
      expect(updated.symbol).toBe("REDO");

      // And re-claimable: a retried deploy after a failed one must not be stuck
      // failing the pending-only claim.
      expect(await tokenService.beginTokenDeploy("tok_claim_release")).not.toBeNull();
    });

    it("does not revert an already-deployed token when release is called", async () => {
      await insertToken("tok_claim_release_noop", {
        status: "active",
        mintAddress: "Dep1oyed22222222222222222222222222222222222",
      });

      await tokenService.releaseTokenDeploy("tok_claim_release_noop");

      expect(await readStatus("tok_claim_release_noop")).toBe("active");
    });

    it("applies tenant predicates before deployment and supply mutations", async () => {
      const foreignProjectId = "prj_token_foreign";
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Foreign Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(foreignProjectId, TEST_ORG.id, foreignProjectId, TEST_USER.id)
        .run();
      for (const [id, status] of [
        ["tok_foreign_claim", "pending"],
        ["tok_foreign_release", "deploying"],
        ["tok_foreign_deployed", "pending"],
        ["tok_foreign_supply", "active"],
        ["tok_foreign_reserve", "active"],
        ["tok_foreign_child", "active"],
      ] as const) {
        await insertToken(id, { projectId: foreignProjectId, status });
      }

      const { entry: foreignEntry } = await tokenService.addAllowlistEntry({
        tokenId: "tok_foreign_child",
        address: "ForeignAllowlist111111111111111111111111111111",
        addedBy: TEST_USER.id,
      });
      await tokenService.freezeAccount({
        tokenId: "tok_foreign_child",
        accountAddress: "foreign_account",
        frozenBy: TEST_USER.id,
      });
      const { transaction: foreignTransaction } = await tokenService.createTransaction({
        tokenId: "tok_foreign_child",
        organizationId: TEST_ORG.id,
        type: "mint",
        params: { destination: "foreign_account", amount: "1" },
        idempotencyKey: "foreign-idempotency-key",
        idempotencyFingerprint: "foreign-idempotency-fingerprint",
      });

      const scoped = new TokenService(
        db,
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      );

      await expect(scoped.beginTokenDeploy("tok_foreign_claim")).resolves.toBeNull();
      await scoped.releaseTokenDeploy("tok_foreign_release");
      await expect(
        scoped.setTokenDeployed(
          "tok_foreign_deployed",
          "ForeignMint111111111111111111111111111111111",
          "ForeignAuthority11111111111111111111111111111",
          null
        )
      ).rejects.toThrow("TOKEN_NOT_FOUND");
      await expect(scoped.setSupplyFromBaseUnits("tok_foreign_supply", "999")).rejects.toThrow(
        "TOKEN_NOT_FOUND"
      );
      await expect(scoped.reserveMintSupply("tok_foreign_reserve", "999")).resolves.toBeNull();

      // Child resources must enforce the same boundary even when a caller has
      // only a globally unique entry/transaction id.
      await expect(scoped.getAllowlistEntry(foreignEntry.id)).resolves.toBeNull();
      await expect(scoped.listAllowlistEntries("tok_foreign_child")).rejects.toThrow(
        "TOKEN_NOT_FOUND"
      );
      await expect(scoped.listAllowlistLabels("tok_foreign_child")).rejects.toThrow(
        "TOKEN_NOT_FOUND"
      );
      await expect(scoped.revokeAllowlistEntry(foreignEntry.id)).rejects.toThrow(
        "ALLOWLIST_ENTRY_NOT_FOUND"
      );
      await expect(scoped.activateAllowlistEntry(foreignEntry.id)).rejects.toThrow(
        "ALLOWLIST_ENTRY_NOT_FOUND"
      );
      await expect(scoped.deleteAllowlistEntry(foreignEntry.id)).rejects.toThrow(
        "ALLOWLIST_ENTRY_NOT_FOUND"
      );
      await expect(
        scoped.addAllowlistEntry({
          tokenId: "tok_foreign_child",
          address: "BlockedForeignAdd11111111111111111111111111111",
          addedBy: TEST_USER.id,
        })
      ).rejects.toThrow("TOKEN_NOT_FOUND");

      await expect(
        scoped.freezeAccount({
          tokenId: "tok_foreign_child",
          accountAddress: "blocked_foreign_account",
          frozenBy: TEST_USER.id,
        })
      ).rejects.toThrow("TOKEN_NOT_FOUND");
      await expect(
        scoped.unfreezeAccount("tok_foreign_child", "foreign_account", TEST_USER.id)
      ).rejects.toThrow("TOKEN_NOT_FOUND");
      await expect(scoped.listFrozenAccounts("tok_foreign_child")).rejects.toThrow(
        "TOKEN_NOT_FOUND"
      );

      await expect(scoped.getTransaction(foreignTransaction.id)).resolves.toBeNull();
      await expect(
        scoped.updateTransaction(foreignTransaction.id, { status: "confirmed" })
      ).rejects.toThrow("TRANSACTION_NOT_FOUND");
      await expect(scoped.listTokenTransactions("tok_foreign_child")).rejects.toThrow(
        "TOKEN_NOT_FOUND"
      );
      await expect(
        scoped.listTransactions({
          organizationId: TEST_ORG.id,
          projectId: foreignProjectId,
        })
      ).rejects.toThrow("cannot override the repository project scope");

      await expect(readStatus("tok_foreign_claim")).resolves.toBe("pending");
      await expect(readStatus("tok_foreign_release")).resolves.toBe("deploying");
      const rows = await db
        .prepare(
          `SELECT id, mint_address, total_supply_cached
           FROM issued_tokens
           WHERE id IN ('tok_foreign_deployed', 'tok_foreign_reserve', 'tok_foreign_supply')
           ORDER BY id`
        )
        .all<{ id: string; mint_address: string | null; total_supply_cached: string }>();
      expect(rows.results).toEqual([
        { id: "tok_foreign_deployed", mint_address: null, total_supply_cached: "0" },
        { id: "tok_foreign_reserve", mint_address: null, total_supply_cached: "0" },
        { id: "tok_foreign_supply", mint_address: null, total_supply_cached: "0" },
      ]);

      const childState = await db
        .prepare(
          `SELECT
             (SELECT status FROM token_allowlists WHERE id = ?) AS allowlist_status,
             (SELECT unfrozen_at FROM frozen_accounts WHERE token_id = ? AND account_address = ?) AS unfrozen_at,
             (SELECT status FROM issuance_transactions WHERE id = ?) AS transaction_status`
        )
        .bind(foreignEntry.id, "tok_foreign_child", "foreign_account", foreignTransaction.id)
        .first<{
          allowlist_status: string;
          unfrozen_at: string | null;
          transaction_status: string;
        }>();
      expect(childState).toEqual({
        allowlist_status: "active",
        unfrozen_at: null,
        transaction_status: "pending",
      });
    });
  });

  describe("allowlist search + label filtering", () => {
    const TOKEN_ID = "tok_freeze_refreeze";
    const ADDR_TREASURY_A = "Aaa1111111111111111111111111111111111111111";
    const ADDR_MARKET_MAKER = "Bbb2222222222222222222222222222222222222222";
    const ADDR_TREASURY_B = "Ccc3333333333333333333333333333333333333333";
    const ADDR_NO_LABEL = "Ddd4444444444444444444444444444444444444444";
    const ADDR_PERCENT = "Eee5555555555555555555555555555555555555555";

    beforeEach(async () => {
      await db.prepare("DELETE FROM token_allowlists WHERE token_id = ?").bind(TOKEN_ID).run();
      for (const [address, label] of [
        [ADDR_TREASURY_A, "Treasury"],
        [ADDR_MARKET_MAKER, "Market maker"],
        [ADDR_TREASURY_B, "Treasury"],
        [ADDR_NO_LABEL, undefined],
        [ADDR_PERCENT, "50%-off"],
      ] as const) {
        await tokenService.addAllowlistEntry({
          tokenId: TOKEN_ID,
          address,
          addedBy: TEST_USER.id,
          label,
        });
      }
    });

    it("matches search against the address", async () => {
      const { entries, total } = await tokenService.listAllowlistEntries(TOKEN_ID, {
        search: "Bbb222",
      });
      expect(total).toBe(1);
      expect(entries.map((entry) => entry.address)).toEqual([ADDR_MARKET_MAKER]);
    });

    it("matches search against the label", async () => {
      const { entries, total } = await tokenService.listAllowlistEntries(TOKEN_ID, {
        search: "market",
      });
      expect(total).toBe(1);
      expect(entries[0]?.address).toBe(ADDR_MARKET_MAKER);
    });

    it("treats LIKE wildcards in search as literal characters", async () => {
      // The '%' must match the "50%-off" label literally, not as a wildcard.
      const { entries, total } = await tokenService.listAllowlistEntries(TOKEN_ID, {
        search: "50%",
      });
      expect(total).toBe(1);
      expect(entries[0]?.address).toBe(ADDR_PERCENT);
    });

    it("filters by exact label", async () => {
      const { entries, total } = await tokenService.listAllowlistEntries(TOKEN_ID, {
        label: "Treasury",
      });
      expect(total).toBe(2);
      expect(entries.map((entry) => entry.address).sort()).toEqual(
        [ADDR_TREASURY_A, ADDR_TREASURY_B].sort()
      );
    });

    it("combines search and label filters", async () => {
      const { entries, total } = await tokenService.listAllowlistEntries(TOKEN_ID, {
        label: "Treasury",
        search: "Aaa",
      });
      expect(total).toBe(1);
      expect(entries[0]?.address).toBe(ADDR_TREASURY_A);
    });

    it("paginates the filtered result with an accurate total", async () => {
      const { entries, total } = await tokenService.listAllowlistEntries(TOKEN_ID, {
        limit: 2,
        offset: 0,
      });
      expect(total).toBe(5);
      expect(entries).toHaveLength(2);
    });

    it("lists distinct non-null labels (sorted) plus the unfiltered total", async () => {
      const { labels, total } = await tokenService.listAllowlistLabels(TOKEN_ID);
      expect(labels).toEqual(["50%-off", "Market maker", "Treasury"]);
      // 5 entries seeded (one has no label); total is unfiltered by label.
      expect(total).toBe(5);
    });

    it("installs the search + label filter indexes", async () => {
      const indexes = await db
        .prepare(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE indexname IN (
             'idx_token_allowlist_search_trgm',
             'idx_token_allowlist_token_status_label'
           )`
        )
        .all<{ indexdef: string; indexname: string }>();

      expect(indexes.results.map((index) => index.indexname).sort()).toEqual([
        "idx_token_allowlist_search_trgm",
        "idx_token_allowlist_token_status_label",
      ]);
      const trgmIndex = indexes.results.find(
        (index) => index.indexname === "idx_token_allowlist_search_trgm"
      );
      expect(trgmIndex?.indexdef).toContain("gin_trgm_ops");
    });
  });

  describe("listTokenTransactions type + status filtering", () => {
    const TOKEN_ID = "tok_freeze_refreeze";

    beforeEach(async () => {
      await db.prepare("DELETE FROM issuance_transactions WHERE token_id = ?").bind(TOKEN_ID).run();
      // [id, type, status, created_at] — created_at ascending so ORDER BY DESC is deterministic.
      const rows = [
        ["itx_mint_1", "mint", "confirmed", "2026-01-01T00:00:01.000Z"],
        ["itx_mint_2", "mint", "confirmed", "2026-01-01T00:00:02.000Z"],
        ["itx_mint_3", "mint", "confirmed", "2026-01-01T00:00:03.000Z"],
        ["itx_mint_4", "mint", "confirmed", "2026-01-01T00:00:04.000Z"],
        ["itx_mint_pending", "mint", "pending", "2026-01-01T00:00:05.000Z"],
        ["itx_burn_1", "burn", "confirmed", "2026-01-01T00:00:06.000Z"],
        ["itx_burn_2", "burn", "confirmed", "2026-01-01T00:00:07.000Z"],
      ] as const;
      for (const [id, type, status, createdAt] of rows) {
        await db
          .prepare(
            `INSERT INTO issuance_transactions
             (id, token_id, organization_id, type, status, operation_params, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`
          )
          .bind(id, TOKEN_ID, TEST_ORG.id, type, status, createdAt, createdAt)
          .run();
      }
    });

    it("returns all transactions newest-first without filters", async () => {
      const { transactions, total } = await tokenService.listTokenTransactions(TOKEN_ID, {
        organizationId: TEST_ORG.id,
      });
      expect(total).toBe(7);
      expect(transactions[0]?.id).toBe("itx_burn_2");
    });

    it("filters by type", async () => {
      const { transactions, total } = await tokenService.listTokenTransactions(TOKEN_ID, {
        organizationId: TEST_ORG.id,
        type: "mint",
      });
      expect(total).toBe(5);
      expect(transactions.every((tx) => tx.type === "mint")).toBe(true);
    });

    it("combines type and status filters", async () => {
      const { transactions, total } = await tokenService.listTokenTransactions(TOKEN_ID, {
        organizationId: TEST_ORG.id,
        type: "mint",
        status: "confirmed",
      });
      expect(total).toBe(4);
      expect(transactions.every((tx) => tx.type === "mint" && tx.status === "confirmed")).toBe(
        true
      );
    });

    it("paginates the filtered result with an accurate total", async () => {
      const { transactions, total } = await tokenService.listTokenTransactions(TOKEN_ID, {
        organizationId: TEST_ORG.id,
        type: "mint",
        limit: 2,
        offset: 0,
      });
      expect(total).toBe(5);
      expect(transactions).toHaveLength(2);
    });

    it("orders same-timestamp rows stably across pages", async () => {
      // All five share one created_at, so only the id tiebreaker keeps paging
      // deterministic — without it a row can repeat or vanish between pages.
      const sharedAt = "2026-03-01T00:00:00.000Z";
      await db.prepare("DELETE FROM issuance_transactions WHERE token_id = ?").bind(TOKEN_ID).run();
      for (const id of ["itx_tie_a", "itx_tie_b", "itx_tie_c", "itx_tie_d", "itx_tie_e"]) {
        await db
          .prepare(
            `INSERT INTO issuance_transactions
             (id, token_id, organization_id, type, status, operation_params, created_at, updated_at)
             VALUES (?, ?, ?, 'mint', 'confirmed', '{}', ?, ?)`
          )
          .bind(id, TOKEN_ID, TEST_ORG.id, sharedAt, sharedAt)
          .run();
      }

      const pageIds: string[] = [];
      for (let offset = 0; offset < 5; offset += 2) {
        const { transactions } = await tokenService.listTokenTransactions(TOKEN_ID, {
          organizationId: TEST_ORG.id,
          limit: 2,
          offset,
        });
        pageIds.push(...transactions.map((tx) => tx.id));
      }

      // Every row appears exactly once, newest-id first within the tie.
      expect(pageIds).toEqual(["itx_tie_e", "itx_tie_d", "itx_tie_c", "itx_tie_b", "itx_tie_a"]);
      expect(new Set(pageIds).size).toBe(5);
    });

    it("installs the type filter index", async () => {
      const indexes = await db
        .prepare(
          `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_issuance_tx_token_type_created'`
        )
        .all<{ indexname: string }>();
      expect(indexes.results.map((index) => index.indexname)).toContain(
        "idx_issuance_tx_token_type_created"
      );
    });
  });

  describe("listTokens search + filters + sorting", () => {
    // [id, name, symbol, mint, template, status, deployedAt, createdAt]
    const SEED_TOKENS = [
      [
        "tok_list_acme",
        "Acme USD",
        "AUSD",
        "So11111111111111111111111111111111111111113",
        "stablecoin",
        "active",
        "2026-01-02T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
      [
        "tok_list_beta",
        "Beta Points",
        "BETA",
        null,
        "arcade",
        "pending",
        null,
        "2026-02-01T00:00:00.000Z",
      ],
      [
        "tok_list_zeta",
        "zeta bond",
        "ZETA",
        "So11111111111111111111111111111111111111114",
        "tokenized-security",
        "paused",
        "2026-03-02T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
      ],
      [
        "tok_list_pct",
        "100% Reserve",
        "PCT",
        null,
        "custom",
        "pending",
        null,
        "2026-04-01T00:00:00.000Z",
      ],
    ] as const;

    async function insertToken([id, name, symbol, mint, template, status, deployedAt, createdAt]:
      | (typeof SEED_TOKENS)[number]
      | readonly [string, string, string, string | null, string, string, string | null, string]) {
      await db
        .prepare(
          `INSERT INTO issued_tokens (
             id, project_id, organization_id, mint_address, name, symbol, decimals,
             total_supply_cached, is_mintable, freeze_authority_enabled, allowlist_enabled,
             template, status, deployed_at, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 6, '0', 1, 1, 0, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          TEST_PROJECT.id,
          TEST_ORG.id,
          mint,
          name,
          symbol,
          template,
          status,
          deployedAt,
          TEST_PROJECT_API_KEY.id,
          createdAt,
          createdAt
        )
        .run();
    }

    beforeEach(async () => {
      // Drop the outer seed token so the assertions below own the whole project.
      await db
        .prepare("DELETE FROM issued_tokens WHERE project_id = ?")
        .bind(TEST_PROJECT.id)
        .run();
      for (const token of SEED_TOKENS) {
        await insertToken(token);
      }
    });

    it("returns every token newest-first by default", async () => {
      const { tokens, total } = await tokenService.listTokens(TEST_PROJECT.id);
      expect(total).toBe(4);
      expect(tokens.map((token) => token.id)).toEqual([
        "tok_list_pct",
        "tok_list_zeta",
        "tok_list_beta",
        "tok_list_acme",
      ]);
    });

    it("matches search against name, symbol, mint address and id", async () => {
      for (const [needle, expected] of [
        ["acme", "tok_list_acme"],
        ["BETA", "tok_list_beta"],
        ["1111111111114", "tok_list_zeta"],
        ["tok_list_pct", "tok_list_pct"],
      ] as const) {
        const { tokens, total } = await tokenService.listTokens(TEST_PROJECT.id, {
          search: needle,
        });
        expect(total, `search=${needle}`).toBe(1);
        expect(tokens[0]?.id, `search=${needle}`).toBe(expected);
      }
    });

    it("treats LIKE wildcards in search as literal characters", async () => {
      // The '%' must match "100% Reserve" literally, not as a wildcard.
      const { tokens, total } = await tokenService.listTokens(TEST_PROJECT.id, { search: "100%" });
      expect(total).toBe(1);
      expect(tokens[0]?.id).toBe("tok_list_pct");

      // "Beta Points" contains "ta " — it would match if `_` were still a
      // single-character wildcard, and must not now that it is escaped.
      const wildcardUnderscore = await tokenService.listTokens(TEST_PROJECT.id, {
        search: "ta_",
      });
      expect(wildcardUnderscore.total).toBe(0);

      // Escaping must not break matching a literal underscore either: every
      // seeded id carries one.
      const literalUnderscore = await tokenService.listTokens(TEST_PROJECT.id, {
        search: "tok_list",
      });
      expect(literalUnderscore.total).toBe(4);
    });

    it("filters by the raw status column", async () => {
      const { tokens, total } = await tokenService.listTokens(TEST_PROJECT.id, {
        status: "pending",
      });
      expect(total).toBe(2);
      expect(tokens.every((token) => token.status === "pending")).toBe(true);
    });

    it("filters by derived deployment status", async () => {
      const draft = await tokenService.listTokens(TEST_PROJECT.id, { deploymentStatus: "draft" });
      expect(draft.tokens.map((token) => token.id).sort()).toEqual([
        "tok_list_beta",
        "tok_list_pct",
      ]);

      const active = await tokenService.listTokens(TEST_PROJECT.id, { deploymentStatus: "active" });
      expect(active.tokens.map((token) => token.id)).toEqual(["tok_list_acme"]);

      const paused = await tokenService.listTokens(TEST_PROJECT.id, { deploymentStatus: "paused" });
      expect(paused.tokens.map((token) => token.id)).toEqual(["tok_list_zeta"]);
    });

    it("filters by template", async () => {
      const { tokens, total } = await tokenService.listTokens(TEST_PROJECT.id, {
        template: "stablecoin",
      });
      expect(total).toBe(1);
      expect(tokens[0]?.id).toBe("tok_list_acme");
    });

    it("filters by an inclusive created_at window", async () => {
      const { tokens, total } = await tokenService.listTokens(TEST_PROJECT.id, {
        createdAfter: "2026-02-01T00:00:00.000Z",
        createdBefore: "2026-03-01T00:00:00.000Z",
      });
      expect(total).toBe(2);
      expect(tokens.map((token) => token.id)).toEqual(["tok_list_zeta", "tok_list_beta"]);
    });

    it("combines search with filters and reports the filtered total", async () => {
      const { tokens, total } = await tokenService.listTokens(TEST_PROJECT.id, {
        search: "e",
        deploymentStatus: "draft",
        limit: 1,
      });
      // "Beta Points", "100% Reserve" (Reserve) both match; only one is returned.
      expect(total).toBe(2);
      expect(tokens).toHaveLength(1);
    });

    it("sorts by name case-insensitively in both directions", async () => {
      const ascending = await tokenService.listTokens(TEST_PROJECT.id, {
        sortBy: "name",
        sortDirection: "asc",
      });
      expect(ascending.tokens.map((token) => token.name)).toEqual([
        "100% Reserve",
        "Acme USD",
        "Beta Points",
        // Lowercase 'z' sorts last only because the comparison is lowered.
        "zeta bond",
      ]);

      const descending = await tokenService.listTokens(TEST_PROJECT.id, {
        sortBy: "name",
        sortDirection: "desc",
      });
      expect(descending.tokens.map((token) => token.name)).toEqual([
        "zeta bond",
        "Beta Points",
        "Acme USD",
        "100% Reserve",
      ]);
    });

    it("sorts oldest-first when asked", async () => {
      const { tokens } = await tokenService.listTokens(TEST_PROJECT.id, {
        sortBy: "createdAt",
        sortDirection: "asc",
      });
      expect(tokens.map((token) => token.id)).toEqual([
        "tok_list_acme",
        "tok_list_beta",
        "tok_list_zeta",
        "tok_list_pct",
      ]);
    });

    it("falls back to the default ordering for an unknown sort key", async () => {
      const { tokens } = await tokenService.listTokens(TEST_PROJECT.id, {
        // Simulates an unvalidated caller: must not reach SQL as-is.
        sortBy: "created_at; DROP TABLE issued_tokens" as never,
      });
      expect(tokens.map((token) => token.id)).toEqual([
        "tok_list_pct",
        "tok_list_zeta",
        "tok_list_beta",
        "tok_list_acme",
      ]);
    });

    it("orders same-timestamp rows stably across pages", async () => {
      // All five share one created_at, so only the id tiebreaker keeps paging
      // deterministic — without it a row can repeat or vanish between pages.
      const sharedAt = "2026-05-01T00:00:00.000Z";
      await db
        .prepare("DELETE FROM issued_tokens WHERE project_id = ?")
        .bind(TEST_PROJECT.id)
        .run();
      for (const suffix of ["a", "b", "c", "d", "e"]) {
        await insertToken([
          `tok_tie_${suffix}`,
          `Tie ${suffix}`,
          "TIE",
          null,
          "custom",
          "pending",
          null,
          sharedAt,
        ]);
      }

      const pageIds: string[] = [];
      for (let offset = 0; offset < 5; offset += 2) {
        const { tokens } = await tokenService.listTokens(TEST_PROJECT.id, { limit: 2, offset });
        pageIds.push(...tokens.map((token) => token.id));
      }

      expect(pageIds).toEqual(["tok_tie_e", "tok_tie_d", "tok_tie_c", "tok_tie_b", "tok_tie_a"]);
      expect(new Set(pageIds).size).toBe(5);
    });

    it("reports facets unaffected by list filters", async () => {
      const facets = await tokenService.listTokenFacets(TEST_PROJECT.id);
      expect(facets.total).toBe(4);
      expect(facets.templates).toEqual([
        { template: "arcade", count: 1 },
        { template: "custom", count: 1 },
        { template: "stablecoin", count: 1 },
        { template: "tokenized-security", count: 1 },
      ]);
      expect(facets.deploymentStatuses).toEqual({ draft: 2, active: 1, paused: 1 });
    });

    it("scopes the list and its facets to the project", async () => {
      const { total } = await tokenService.listTokens("proj_does_not_exist");
      expect(total).toBe(0);
      const facets = await tokenService.listTokenFacets("proj_does_not_exist");
      expect(facets).toEqual({
        templates: [],
        deploymentStatuses: { draft: 0, active: 0, paused: 0 },
        total: 0,
      });
    });

    it("installs the search, sort and filter indexes", async () => {
      const indexes = await db
        .prepare(
          `SELECT indexname, indexdef
             FROM pg_indexes
            WHERE indexname IN (
              'idx_issued_tokens_search_trgm',
              'idx_issued_tokens_project_created_id',
              'idx_issued_tokens_project_name',
              'idx_issued_tokens_project_status_created_id',
              'idx_issued_tokens_project_template_created_id'
            )`
        )
        .all<{ indexdef: string; indexname: string }>();

      expect(indexes.results.map((index) => index.indexname).sort()).toEqual([
        "idx_issued_tokens_project_created_id",
        "idx_issued_tokens_project_name",
        "idx_issued_tokens_project_status_created_id",
        "idx_issued_tokens_project_template_created_id",
        "idx_issued_tokens_search_trgm",
      ]);
      const trgmIndex = indexes.results.find(
        (index) => index.indexname === "idx_issued_tokens_search_trgm"
      );
      expect(trgmIndex?.indexdef).toContain("gin_trgm_ops");
    });
  });
});
