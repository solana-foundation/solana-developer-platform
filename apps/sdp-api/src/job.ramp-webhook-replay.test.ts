import * as solanaRpc from "@sdp/rpc/solana";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { currentDatabaseIdentity } from "@/db/identity";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import { getProcessEnv } from "@/lib/runtime-env";
import { cleanupRetiredProviderCredentialSecrets } from "@/services/jobs/cleanup-provider-credential-secrets";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import { detectOrphanedEarnSplitSwaps } from "@/services/jobs/detect-orphaned-earn-split-swaps";
import { pollRingsIndexing } from "@/services/jobs/poll-rings-indexing";
import { reconcileDvpTrades } from "@/services/jobs/reconcile-dvp-trades";
import { reconcileEarnVaultMovements } from "@/services/jobs/reconcile-earn-vault-movements";
import { reconcileRevokedApiKeyCache } from "@/services/jobs/reconcile-revoked-api-key-cache";
import { reconcileSponsorshipBudgets } from "@/services/jobs/reconcile-sponsorship-budgets";
import { retireOrphanedSecrets } from "@/services/jobs/retire-orphaned-secrets";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { runCronJob } from "./job";

/**
 * Managed-job regression for the durable ramp webhook inbox (APE-840 /
 * SOLA9-660): the managed Cloud Run reconciliation job is the ONLY cron tick a
 * managed deployment gets, so it must replay pending `ramp_webhook_events`
 * rows exactly like the in-process scheduler's pending-transfers wrapper does.
 * Without that, an acknowledged webhook whose background apply never ran
 * strands its transfer in `awaiting_payment` forever on managed deployments.
 *
 * The peripheral ticks are mocked so the job's real pending-transfers tick —
 * system database identity, monitor and error handling included — runs the
 * REAL replay against this worker's Postgres. MoonPay stands in for every
 * provider; the inbox sits above the processors.
 */
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: vi.fn(() => {
    throw new Error("No RPC endpoint");
  }),
}));

vi.mock("@/cron/earn-catalogue-sync", () => ({
  EARN_CATALOGUE_SYNC_MONITOR: "sdp-api-sync-earn-catalogue",
  runEarnCatalogueSyncIfDue: vi.fn(async () => "synced"),
}));

vi.mock("@/cron/earn-metrics-refresh", () => ({
  EARN_METRICS_REFRESH_MONITOR: "sdp-api-refresh-earn-metrics",
  runEarnMetricsRefreshTick: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/cleanup-provider-credential-secrets", () => ({
  cleanupRetiredProviderCredentialSecrets: vi.fn(async () => ({
    cleaned: 0,
    skipped: 0,
    failed: 0,
  })),
}));

vi.mock("@/services/jobs/collect-recurring-payments", () => ({
  collectDueRecurringPayments: vi.fn(async () => ({
    recovered: 0,
    collected: 0,
    failed: 0,
    skipped: 0,
  })),
}));

vi.mock("@/services/jobs/poll-rings-indexing", () => ({
  pollRingsIndexing: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/track-pending-transfers", () => ({
  trackPendingTransfers: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/reconcile-revoked-api-key-cache", () => ({
  reconcileRevokedApiKeyCache: vi.fn(async () => ({ scanned: 0, repaired: 0 })),
}));

vi.mock("@/services/jobs/reconcile-sponsorship-budgets", () => ({
  reconcileSponsorshipBudgets: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/detect-orphaned-earn-split-swaps", () => ({
  detectOrphanedEarnSplitSwaps: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/reconcile-earn-vault-movements", () => ({
  reconcileEarnVaultMovements: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/reconcile-dvp-trades", () => ({
  reconcileDvpTrades: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/retire-orphaned-secrets", () => ({
  retireOrphanedSecrets: vi.fn(async () => ({ retired: 0, failed: 0 })),
}));

vi.mock("@/services/policy/approved-operation-replay", () => ({
  recoverApprovedWalletOperations: vi.fn(async () => {}),
}));

// Only the env lookup is stubbed: the job must run against this worker's
// database and Redis, with the managed deployment's required configuration.
vi.mock("@/lib/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime-env")>()),
  getProcessEnv: vi.fn(),
}));

const ORG_ID = "org_managed_replay";
const USER_ID = "usr_managed_replay";
const PROJECT_ID = "prj_managed_replay";
const TRANSFER_ID = "xfr_managed_replay";
const MOONPAY_TRANSACTION_ID = "e3a1f7cb-42c1-4a08-9d5f-0d51e94eb1af";

const completedPayload = {
  type: "transaction_updated",
  externalCustomerId: "MOONPAY-ONRAMP-MANAGED",
  data: {
    id: MOONPAY_TRANSACTION_ID,
    status: "completed",
    externalTransactionId: TRANSFER_ID,
    failureReason: null,
    baseCurrencyAmount: 47.73,
    quoteCurrencyAmount: 0.649,
    walletAddress: "WebhookDestinationSolanaWallet111111111111111111",
    cryptoTransactionId: "t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux",
    baseCurrency: { code: "usd" },
    currency: { code: "sol" },
  },
};

function managedJobEnv(): Env {
  return {
    ...env,
    SIGNING_PROVIDER: "coinbase_cdp",
    CUSTODY_KMS_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    SDP_MANAGED_RECONCILIATION_CRON: "*/5 * * * *",
    SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS: "120",
  } as Env;
}

async function seedMoonpayOnrampTransfer(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(ORG_ID, "Managed Replay Org", "managed-replay-org", "enterprise", "active")
    .run();
  await db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "managed-replay-user@example.com", 1, "active")
    .run();
  await seedDefaultProjects(db, {
    organizationId: ORG_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, counterparty_id, source_address,
         destination_address, token, amount, memo, type, direction, status, provider,
         provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
         signature, serialized_tx, initiated_by_key_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      TRANSFER_ID,
      ORG_ID,
      PROJECT_ID,
      "wallet_managed_replay",
      null,
      null,
      "DestinationSolanaWallet111111111111111111111111",
      "SOL",
      null,
      null,
      "onramp",
      "inbound",
      "awaiting_payment",
      "moonpay",
      null,
      null,
      "USD",
      "47.73",
      {},
      null,
      null,
      null,
      "2026-06-18T00:00:00.000Z",
      "2026-06-18T00:00:00.000Z"
    )
    .run();
}

async function seedAgedPendingInboxRow(): Promise<string> {
  const stored = await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
    provider: "moonpay",
    environment: "sandbox",
    payload: completedPayload,
  });
  // Simulate the crash-after-ack window: the row was persisted before the 200
  // but the background apply never ran. Backdate it past the replay minimum
  // age so the managed job's replay pass claims it.
  await getDb(env)
    .prepare("UPDATE ramp_webhook_events SET created_at = ?, updated_at = ? WHERE id = ?")
    .bind("2026-06-18T00:00:00.000Z", "2026-06-18T00:00:00.000Z", stored.id)
    .run();
  return stored.id;
}

async function readInboxRows() {
  const result = await getDb(env)
    .prepare("SELECT id, status, attempts FROM ramp_webhook_events")
    .all<{ id: string; status: string; attempts: number }>();
  return result.results;
}

async function readTransferStatus(): Promise<string | undefined> {
  const row = await getDb(env)
    .prepare("SELECT status FROM payment_transfers WHERE id = ?")
    .bind(TRANSFER_ID)
    .first<{ status: string }>();
  return row?.status;
}

describe("managed reconciliation job replays the ramp webhook inbox", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    vi.mocked(getProcessEnv).mockReset().mockReturnValue(managedJobEnv());
    // mockReset, not mockClear: a test that stubs an implementation onto a
    // peripheral tick (a rejection, say) must not leak it into the next test
    // — resetting restores each mock's own module-level default.
    vi.mocked(solanaRpc.createRpc).mockReset();
    vi.mocked(trackPendingTransfers).mockReset();
    vi.mocked(reconcileRevokedApiKeyCache).mockReset();
    vi.mocked(recoverApprovedWalletOperations).mockReset();
    vi.mocked(reconcileSponsorshipBudgets).mockReset();
    vi.mocked(collectDueRecurringPayments).mockReset();
    vi.mocked(pollRingsIndexing).mockReset();
    vi.mocked(reconcileEarnVaultMovements).mockReset();
    vi.mocked(reconcileDvpTrades).mockReset();
    vi.mocked(detectOrphanedEarnSplitSwaps).mockReset();
    vi.mocked(retireOrphanedSecrets).mockReset();
    vi.mocked(cleanupRetiredProviderCredentialSecrets).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies an aged pending inbox row and settles its transfer", async () => {
    await seedMoonpayOnrampTransfer();
    const inboxRowId = await seedAgedPendingInboxRow();

    await runCronJob();

    // The linked transfer reached its terminal state…
    expect(await readTransferStatus()).toBe("completed");
    // …and the durable row was discharged.
    expect(await readInboxRows()).toHaveLength(0);
    expect(
      await getDb(env)
        .prepare("SELECT count(*) AS n FROM ramp_webhook_events WHERE id = ?")
        .bind(inboxRowId)
        .first<{ n: number }>()
    ).toMatchObject({ n: 0 });
  });

  it("runs the replay under the pending-transfers tick's system identity", async () => {
    await seedMoonpayOnrampTransfer();
    await seedAgedPendingInboxRow();

    const observeIdentity = vi.fn();
    vi.mocked(reconcileSponsorshipBudgets).mockImplementationOnce(async () => {
      observeIdentity(currentDatabaseIdentity());
    });

    await runCronJob();

    // The tick is cross-tenant by nature: row-level security must have seen
    // the named system identity while the replay claimed and applied rows.
    expect(observeIdentity).toHaveBeenCalledWith({
      kind: "system",
      component: "job:sdp-api-track-pending-transfers",
    });
    expect(await readTransferStatus()).toBe("completed");
    expect(await readInboxRows()).toHaveLength(0);
  });

  it("leaves a fresh inbox row for the in-request background pass", async () => {
    await seedMoonpayOnrampTransfer();
    // No backdating: a row inside the two-minute window belongs to the
    // webhook request's background apply, not the replay.
    await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });

    await runCronJob();

    expect(await readTransferStatus()).toBe("awaiting_payment");
    const rows = await readInboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);
  });

  it("keeps a replay failure fatal to the pending-transfers tick without skipping its siblings", async () => {
    await seedMoonpayOnrampTransfer();
    await seedAgedPendingInboxRow();
    vi.mocked(trackPendingTransfers).mockRejectedValue(new Error("transfers down"));

    await expect(runCronJob()).rejects.toThrow("transfers down");

    // The replay leg runs beside the transfers chain: its sibling still ran
    // (once — the beforeEach reset kept earlier tests' calls out of the
    // count), and the tick's failure surfaces instead of being swallowed.

    expect(reconcileSponsorshipBudgets).toHaveBeenCalledTimes(1);
  });
});
