import { EARN_PROVIDER_CLIENTS } from "@sdp/earn";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, EarnPortfolioWithdrawal } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnRepository, type EarnProviderWalletRow } from "@/db/repositories";
import app from "@/index";
import { applyEarnDepositObservation } from "@/services/earn-deposit-ledger.service";
import { applyEarnWithdrawalObservationToRow } from "@/services/earn-withdrawal-ledger.service";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/**
 * Pins the PRO-1628 crash-window contract in isolation: once the provider has
 * ACCEPTED a withdrawal, a failing ledger write must never fail the response —
 * money moved, bookkeeping retries then yields. Module-mocked (partial) so the
 * to-row applier always throws while everything else stays real; that is why
 * this lives in its own file instead of earn-program.test.ts.
 */
vi.mock("@/services/earn-withdrawal-ledger.service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/earn-withdrawal-ledger.service")>();
  return {
    ...original,
    applyEarnWithdrawalObservationToRow: vi.fn().mockRejectedValue(new Error("ledger db down")),
  };
});

/**
 * The same contract for the OBSERVED half (PRO-1669): the deposits route reports
 * the provider's live page, and its best-effort ledger write must never reach the
 * caller. Mocked here rather than in earn-program.test.ts for the same reason as
 * above — a partial module mock must not leak into the suite that exercises the
 * real applier.
 */
vi.mock("@/services/earn-deposit-ledger.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/earn-deposit-ledger.service")>();
  return {
    ...original,
    applyEarnDepositObservation: vi.fn().mockRejectedValue(new Error("ledger db down")),
  };
});

const TEST_ORG = { id: "org_earn_ledger_fail", name: "Earn Ledger Fail Org", slug: "earn-lf" };
const TEST_PROJECT = { id: "prj_earn_ledger_fail", slug: "earn-ledger-fail-project" };
const TEST_USER = { id: "usr_earn_ledger_fail", email: "earn-ledger-fail@example.com" };
const TEST_API_KEY = {
  id: "key_earn_ledger_fail",
  raw: "sk_test_earn_ledger_fail",
  prefix: "sk_test_elf",
};
const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};
const WALLET_REF = "5a24e45f-ceea-467f-9b6b-3c1a5c7f9d33";
const SOLANA_DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const WITHDRAWAL: EarnPortfolioWithdrawal = {
  withdrawalRef: "wd_ledger_fail_1",
  status: "processing",
  amountRequestedUsd: "10.00",
  token: "usdc",
  destinationAddress: SOLANA_DESTINATION,
  createdAt: "2026-08-11T00:00:00.000Z",
};

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;
let originalGroundSandboxApiKey: string | undefined;
let program: EarnProviderWalletRow;

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalGroundSandboxApiKey = env.GROUND_SANDBOX_API_KEY;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  env.GROUND_SANDBOX_API_KEY = "ground-sandbox-test-api-key";
  await seedTestDatabase(env);

  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, 'enterprise', 'active', ?)"
      )
      .bind(
        TEST_ORG.id,
        TEST_ORG.name,
        TEST_ORG.slug,
        JSON.stringify({ providerOverrides: { earn: { ground: true } } })
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Ledger Fail Key', ?, ?, 'api_admin', ?, 'active')`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_API_KEY.prefix,
        keyHash,
        JSON.stringify(["*"])
      ),
  ]);

  // Captured, not discarded: since PRO-1670 a withdrawal is addressed through
  // its program's own id, so the request URL is built from this row.
  const wallet = await createPostgresEarnRepository(getDb(env)).insertProviderWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "ground",
    providerWalletRef: WALLET_REF,
    label: null,
    createdBy: TEST_USER.id,
  });
  if (!wallet) {
    throw new Error("failed to seed program wallet");
  }
  program = wallet;
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.GROUND_SANDBOX_API_KEY = originalGroundSandboxApiKey;
  await clearKVStores(env);
});

describe("Earn withdrawal ledger — post-acceptance bookkeeping failure", () => {
  it("still returns 201 with the provider's withdrawal when every ledger write fails", async () => {
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
      WITHDRAWAL
    );

    const res = await app.request(
      `/v1/earn/programs/${program.id}/withdrawals`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          // No `provider`: the path program owns it (PRO-1670).
          requestId: "3f9e8d7c-6b5a-4f4e-8d3c-2b1a0f9e8d7c",
          amountUsd: "10.00",
          token: "usdc",
          destinationAddress: SOLANA_DESTINATION,
        }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { withdrawal: { withdrawalRef: string } } };
    expect(body.data.withdrawal.withdrawalRef).toBe(WITHDRAWAL.withdrawalRef);

    // The bookkeeping contract, not just the outcome: three attempts before
    // giving up with the alertable earn_ledger_write_failed log.
    expect(vi.mocked(applyEarnWithdrawalObservationToRow)).toHaveBeenCalledTimes(3);

    // The intent row survives, ref-less: healed by a same-key retry or the
    // ledger sweep — never silently lost, never a failed response. wallet_id is
    // asserted too: with N programs per org+environment+provider legal, the row
    // must be pinned to the program in the PATH, not merely to some program of
    // this organization's.
    const row = await getDb(env)
      .prepare("SELECT status, provider_reference, wallet_id FROM earn_program_movements")
      .first<{ status: string; provider_reference: string | null; wallet_id: string }>();
    expect(row).toEqual({
      status: "requested",
      provider_reference: null,
      wallet_id: program.id,
    });
  });

  it("serves the live deposits page even when every ledger write rejects", async () => {
    const deposits = [
      {
        id: "dep_1",
        amountUsd: "50.00",
        token: "usdc" as const,
        status: "completed" as const,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "dep_2",
        amountUsd: "75.00",
        token: "usdc" as const,
        status: "processing" as const,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    ];
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "listPortfolioDeposits").mockResolvedValue({
      deposits,
      nextCursor: "cursor-2",
    });

    const res = await app.request(
      `/v1/earn/programs/${program.id}/deposits`,
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    // The read is the provider's, so a bookkeeping outage is invisible to it —
    // including the cursor, which a partner is paging on.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { deposits: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(body.data.deposits.map((d) => d.id)).toEqual(["dep_1", "dep_2"]);
    expect(body.data.nextCursor).toBe("cursor-2");

    // Every row on the page is attempted — one failure must not abandon the rest —
    // and ONE attempt each, unlike the post-acceptance withdrawal write's three:
    // the feed re-offers a missed deposit on the very next poll.
    expect(vi.mocked(applyEarnDepositObservation)).toHaveBeenCalledTimes(2);

    // Nothing was written, and nothing was invented.
    const row = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS total FROM earn_program_movements")
      .first<{ total: number }>();
    expect(row?.total).toBe(0);
  });
});
