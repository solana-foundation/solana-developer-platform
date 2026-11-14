import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { runWithDatabaseIdentity } from "@/db/identity";
import { FireblocksProposalsRepository } from "@/db/repositories/fireblocks-proposals.repository";
import { FireblocksReconciliationRepository } from "@/db/repositories/fireblocks-reconciliation.repository";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import * as events from "@/runtime/money-path-events";
import * as transfers from "@/services/payments/fireblocks-transfer";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { reconcileFireblocksProposals } from "./reconcile-fireblocks-proposals";

const org = "org_fireblocks_queue";
const projects = {
  sandbox: "prj_fireblocks_queue_sandbox",
  production: "prj_fireblocks_queue_production",
} as const;
const old = "2026-01-01T00:00:00.000Z";
const address = "11111111111111111111111111111111";
const db = () => getDb(env);
const queue = () => new FireblocksReconciliationRepository(db());
const run = () =>
  runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    reconcileFireblocksProposals(env)
  );

async function seedTransfers(
  count: number,
  environment: SdpEnvironment = "sandbox",
  status = "processing",
  fireblocks = true
) {
  await db().execute(
    `INSERT INTO payment_transfers
    (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, type, direction, status, provider_data, created_at, updated_at)
    SELECT ? || n::text, ?, ?, 'fb_0', ?, ?, 'SOL', '1', 'transfer', 'outbound', ?, ?::jsonb, ?, ?
    FROM generate_series(1, ?) n`,
    [
      `${environment}_${status}_${fireblocks}_`,
      org,
      projects[environment],
      address,
      address,
      status,
      JSON.stringify(fireblocks ? { fireblocksTransfer: {} } : {}),
      old,
      old,
      count,
    ]
  );
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await db().execute(
    "INSERT INTO organizations (id, name, slug, status) VALUES (?, 'Queue', 'fireblocks-queue', 'active')",
    [org]
  );
  await db().execute(
    "INSERT INTO users (id, email, email_verified, status) VALUES ('usr_queue', 'queue@example.com', 1, 'active')"
  );
  await seedDefaultProjects(db(), {
    organizationId: org,
    createdBy: "usr_queue",
    members: [],
    ids: projects,
  });
  await db().execute(
    "INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted) VALUES ('cfg_queue', ?, ?, 'fireblocks', 'unused')",
    [org, projects.sandbox]
  );
  await db().execute(
    "INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key) VALUES ('cwlt_queue', 'cfg_queue', 'fb_0', ?)",
    [address]
  );
});
afterEach(() => vi.restoreAllMocks());

describe("Fireblocks reconciliation queue", () => {
  it("counts exactly the pending candidate set, by environment, including old approvals", async () => {
    await seedTransfers(2);
    await seedTransfers(3, "production");
    await seedTransfers(1, "sandbox", "confirmed");
    await seedTransfers(1, "sandbox", "processing", false);
    await db().execute(
      `INSERT INTO fireblocks_signing_proposals
      (id, organization_id, project_id, custody_wallet_id, connection_id, account_fingerprint, vault_account_id, source_address, asset_id, operation, created_at, updated_at, finished_at)
      SELECT 'fbp_' || n::text, ?, ?, 'cwlt_queue', 'conn_queue', 'account', '0', ?, 'SOL_TEST', 'PROGRAM_CALL', ?, ?, CASE WHEN n = 2 THEN ? ELSE NULL END
      FROM generate_series(1, 2) n`,
      [org, projects.sandbox, address, old, old, old]
    );
    const selected = await queue().list("sandbox", 100);
    const stats = await queue().stats("sandbox", Date.now());
    expect(selected.map((row) => row.id).sort()).toEqual([
      "fbp_1",
      "sandbox_processing_true_1",
      "sandbox_processing_true_2",
    ]);
    expect(stats).toMatchObject({ pending: selected.length, transfers: 2, signing: 1 });
    expect(stats.oldestUnpolledAgeMs).toBeGreaterThan(180_000);
    expect((await queue().stats("production", Date.now())).pending).toBe(3);
    await expect(
      runWithDatabaseIdentity({ kind: "tenant", organizationId: org }, () =>
        queue().list("sandbox", 100)
      )
    ).rejects.toThrow("system-only");
  });

  it("rotates a 500-row backlog in five bounded visits, without expiring approvals", async () => {
    await seedTransfers(500);
    let active = 0;
    let maximumActive = 0;
    const visited: string[] = [];
    vi.spyOn(transfers, "pollFireblocksTransfer").mockImplementation(async (_env, ledger, row) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        const repo = ledger.repo;
        const claimed = await repo.claimFireblocksTransferPoll({
          transferId: row.id,
          organizationId: org,
          projectId: projects.sandbox,
          now: new Date().toISOString(),
          polledBefore: new Date(Date.now() - 15_000).toISOString(),
        });
        if (!claimed) throw new Error("Duplicate queue visit");
        visited.push(row.id);
        return { row: claimed, polled: true };
      } finally {
        active--;
      }
    });
    const log = vi.spyOn(events, "logEvent");
    for (let tick = 0; tick < 5; tick++) await run();
    expect(visited).toHaveLength(500);
    expect(new Set(visited).size).toBe(500);
    expect(maximumActive).toBe(5);
    expect((await queue().stats("sandbox", Date.now())).pending).toBe(500);
    expect(log).toHaveBeenLastCalledWith(
      "info",
      expect.objectContaining({
        event: "sdp_api_fireblocks_reconciliation_tick",
        environment: "sandbox",
        pending: 500,
        selected: 100,
        polled: 100,
        skipped: 0,
        failed: 0,
        duration_ms: expect.any(Number),
      })
    );
  });

  it("reports row failures, continues the batch, and fails the cron instead of reporting healthy", async () => {
    await seedTransfers(3);
    vi.spyOn(transfers, "pollFireblocksTransfer")
      .mockRejectedValueOnce(new Error("Provider offline"))
      .mockImplementation(async (_env, _repo, row) => ({ row, polled: true }));
    const log = vi.spyOn(events, "logEvent");
    await expect(run()).rejects.toThrow("Fireblocks proposal reconciliation failed");
    expect(transfers.pollFireblocksTransfer).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith(
      "error",
      expect.objectContaining({ failed: 1, polled: 2, pending: 3 })
    );
  });

  it("records a lease skip separately from a provider failure", async () => {
    await seedTransfers(1);
    vi.spyOn(transfers, "pollFireblocksTransfer").mockImplementation(async (_env, _repo, row) => ({
      row,
      polled: false,
    }));
    const log = vi.spyOn(events, "logEvent");
    await run();
    expect(log).toHaveBeenLastCalledWith(
      "info",
      expect.objectContaining({ selected: 1, polled: 0, skipped: 1, failed: 0 })
    );
  });

  it("never fabricates a drained backlog when the stats query fails", async () => {
    vi.spyOn(FireblocksReconciliationRepository.prototype, "stats").mockRejectedValue(
      new Error("Database unavailable")
    );
    const log = vi.spyOn(events, "logEvent");
    await expect(run()).rejects.toThrow("Database unavailable");
    expect(
      log.mock.calls.some(([, event]) => event.event === "sdp_api_fireblocks_reconciliation_tick")
    ).toBe(false);
  });

  it("shares the native and signing leases across overlapping pollers", async () => {
    await seedTransfers(1);
    const payments = createSystemPaymentsRepository(env);
    const claim = () =>
      payments.claimFireblocksTransferPoll({
        transferId: "sandbox_processing_true_1",
        organizationId: org,
        projectId: projects.sandbox,
        now: new Date().toISOString(),
        polledBefore: old,
      });
    expect((await Promise.all([claim(), claim()])).filter(Boolean)).toHaveLength(1);
    await db().execute(
      `INSERT INTO fireblocks_signing_proposals
      (id, organization_id, project_id, custody_wallet_id, connection_id, account_fingerprint, vault_account_id, source_address, asset_id, operation)
      VALUES ('fbp_lease', ?, ?, 'cwlt_queue', 'conn_queue', 'account', '0', ?, 'SOL_TEST', 'RAW')`,
      [org, projects.sandbox, address]
    );
    const signing = new FireblocksProposalsRepository(db(), {
      organizationId: org,
      projectId: projects.sandbox,
    });
    expect(
      (await Promise.all([signing.claimPoll("fbp_lease"), signing.claimPoll("fbp_lease")])).filter(
        Boolean
      )
    ).toHaveLength(1);
  });
});
