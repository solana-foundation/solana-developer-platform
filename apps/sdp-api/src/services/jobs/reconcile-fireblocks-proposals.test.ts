import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { createCustodyProposalState } from "@sdp/types/custody-proposals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { runWithDatabaseIdentity } from "@/db/identity";
import { FireblocksProposalsRepository } from "@/db/repositories/fireblocks-proposals.repository";
import { FireblocksReconciliationRepository } from "@/db/repositories/fireblocks-reconciliation.repository";
import * as events from "@/runtime/money-path-events";
import * as signingProposals from "@/services/custody/fireblocks-proposal-reconciliation";
import { systemProposalLedger } from "@/services/jobs/proposal-recovery-ledger";
import * as transfers from "@/services/payments/fireblocks-transfer";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { reconcileFireblocksProposals } from "./reconcile-fireblocks-proposals";

const org = "org_fireblocks_queue";
const projects = {
  sandbox: "prj_fireblocks_queue_sandbox",
  production: "prj_fireblocks_queue_production",
} as const;
const old = "2026-01-01T00:00:00.000Z";
const address = TEST_CUSTODY_PUBLIC_KEY;
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
    expect(stats).toMatchObject({ pending: 3, transfers: 2, signing: 1 });
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
        await ledger.proposals.ensureForTransfer({
          transfer: row,
          provider: "fireblocks",
          binding: {},
          state: createCustodyProposalState(),
          now: old,
        });
        const claimed = await ledger.proposals.claimForPoll({
          transferId: row.id,
          organizationId: org,
          projectId: projects.sandbox,
          now: new Date().toISOString(),
          polledBefore: new Date(Date.now() - 15_000).toISOString(),
        });
        if (!claimed) throw new Error("Duplicate queue visit");
        visited.push(row.id);
        return { row, polled: true };
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

  it("uses canonical poll timestamps for queue rotation and freshness, with legacy reads", async () => {
    await seedTransfers(2);
    await db().execute(
      `UPDATE payment_transfers SET provider_data = provider_data || jsonb_build_object(
        'fireblocksLastPolledAt', CASE WHEN id = 'sandbox_processing_true_1' THEN ? ELSE ? END)
        WHERE organization_id = ?`,
      ["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z", org]
    );
    const ledger = systemProposalLedger(env);
    const row = await ledger.repo.getTransferById({
      transferId: "sandbox_processing_true_1",
      organizationId: org,
      projectId: projects.sandbox,
    });
    if (row === null) throw new Error("Missing seeded transfer");
    await ledger.proposals.ensureForTransfer({
      transfer: row,
      provider: "fireblocks",
      binding: {},
      state: createCustodyProposalState(),
      now: old,
    });
    expect(
      await ledger.proposals.claimForPoll({
        transferId: row.id,
        organizationId: org,
        projectId: projects.sandbox,
        now: "2026-01-04T00:00:00.000Z",
        polledBefore: old,
      })
    ).not.toBeNull();
    expect((await queue().list("sandbox", 100)).map((candidate) => candidate.id)).toEqual([
      "sandbox_processing_true_2",
      "sandbox_processing_true_1",
    ]);
    expect(await queue().stats("sandbox", Date.parse("2026-01-05T00:00:00.000Z"))).toMatchObject({
      pending: 2,
      oldestUnpolledAgeMs: 172_800_000,
    });
    expect(
      (
        await ledger.repo.getTransferById({
          transferId: row.id,
          organizationId: org,
          projectId: projects.sandbox,
        })
      )?.updated_at
    ).toBe(old);
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

  it("rotates malformed native intents so a full failed page cannot starve signing proposals", async () => {
    await seedTransfers(100);
    await db().execute(
      "UPDATE payment_transfers SET custody_wallet_id = 'cwlt_queue' WHERE organization_id = ?",
      [org]
    );
    await db().execute(
      `INSERT INTO fireblocks_signing_proposals
      (id, organization_id, project_id, custody_wallet_id, connection_id, account_fingerprint, vault_account_id, source_address, asset_id, operation, created_at, updated_at)
      VALUES ('fbp_after_malformed', ?, ?, 'cwlt_queue', 'conn_queue', 'account', '0', ?, 'SOL_TEST', 'RAW', ?, ?)`,
      [org, projects.sandbox, address, old, "2026-01-02T00:00:00.000Z"]
    );
    const ledger = systemProposalLedger(env);
    const identity = {
      transferId: "sandbox_processing_true_1",
      organizationId: org,
      projectId: projects.sandbox,
    };
    const transfer = await ledger.repo.getTransferById(identity);
    if (transfer === null) throw new Error("Missing malformed transfer");
    const canonical = await ledger.proposals.ensureForTransfer({
      transfer,
      provider: "fireblocks",
      binding: {},
      state: createCustodyProposalState(),
      now: old,
    });
    const signingPoll = vi
      .spyOn(signingProposals, "pollFireblocksSigningProposal")
      .mockImplementation(async (_env, _repo, row) => ({ row, polled: true }));
    const provider = vi.spyOn(globalThis, "fetch");
    const log = vi.spyOn(events, "logEvent").mockImplementation(() => undefined);
    await expect(run()).rejects.toThrow("Fireblocks proposal reconciliation failed");
    expect(signingPoll).not.toHaveBeenCalled();
    expect(await ledger.proposals.getForTransfer(identity)).toEqual(canonical);
    expect(await db().queryOne("SELECT COUNT(*)::int AS count FROM custody_proposals")).toEqual({
      count: 1,
    });
    expect(required(await ledger.repo.getTransferById(identity)).provider_data).toMatchObject({
      fireblocksTransfer: {},
      fireblocksLastPolledAt: expect.any(String),
    });
    expect(log).toHaveBeenLastCalledWith(
      "error",
      expect.objectContaining({ failed: 100, polled: 0, pending: 101 })
    );
    expect(required((await queue().list("sandbox", 100))[0]).id).toBe("fbp_after_malformed");
    await expect(run()).rejects.toThrow("Fireblocks proposal reconciliation failed");
    expect(signingPoll).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
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
    const ledger = systemProposalLedger(env);
    const row = await ledger.repo.getTransferById({
      transferId: "sandbox_processing_true_1",
      organizationId: org,
      projectId: projects.sandbox,
    });
    if (row === null) throw new Error("Missing seeded transfer");
    await ledger.proposals.ensureForTransfer({
      transfer: row,
      provider: "fireblocks",
      binding: {},
      state: createCustodyProposalState(),
      now: old,
    });
    const claim = () =>
      ledger.proposals.claimForPoll({
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
