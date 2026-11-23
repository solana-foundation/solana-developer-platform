import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldIo } from "node:timers/promises";
import type { FireblocksTransferResult } from "@sdp/custody/provisioning/fireblocks-transfers";
import { runInClusterScope } from "@sdp/rpc/scope";
import { createCustodyProposalState } from "@sdp/types/custody-proposals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { custodyProposalsCron } from "@/cron/reconcile-custody-proposals";
import {
  type DatabaseClient,
  type DatabaseExecutor,
  getDb,
  type PreparedStatement,
} from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { forbidden } from "@/lib/errors";
import { rootLogger } from "@/runtime/logger";
import { AuditService, type SystemAuditLogEntry } from "@/services/audit.service";
import {
  type CustodyProposalRecovery,
  ProposalAdmissionRefusedError,
} from "@/services/domain/signing/admitted-proposer";
import { systemProposalLedger } from "@/services/jobs/proposal-recovery-ledger";
import { applyProposalObservation } from "@/services/payments/fireblocks-transfer";
import * as signer from "@/services/solana/signer";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";

const START = Date.parse("2026-11-23T00:00:00.000Z");
const MINUTE = 60_000;
const ROWS = 500;
const REVOKED = 50;
const PROVIDER_MS = 1_000;
const LOCAL_ROW_MS = 1_000;
const BATCH_MS = 5_000;
const organization = { id: "org_custody_capacity", slug: "custody-capacity" };
const member = organizationMember("custody_capacity", "admin");
const binding = {
  version: 1,
  provider: "fireblocks",
  connectionId: "connection_capacity",
  accountFingerprint: "account_capacity",
  vaultAccountId: "vault_capacity",
  assetId: "SOL_TEST",
};

interface Run {
  reads: Set<string>;
  localCharged: Set<string>;
  providerActive: number;
  providerPeak: number;
  startedAt: number;
  finishedAt: number;
}

/** Real SQL drains before modeled I/O advances; Date alone is virtual. */
function capacityClock() {
  let databaseWork = 0;
  const waits: { due: number; resolve: () => void }[] = [];
  function delay(ms: number) {
    const wait = deferred<void>();
    waits.push({ due: Date.now() + ms, resolve: () => wait.resolve() });
    return wait.promise;
  }
  async function track<T>(work: () => Promise<T>): Promise<T> {
    databaseWork++;
    try {
      return await work();
    } finally {
      databaseWork--;
    }
  }
  const db = getDb(env);
  const prepare = db.prepare.bind(db);
  const transaction = db.transaction.bind(db);
  function trackedStatement(statement: PreparedStatement): PreparedStatement {
    return {
      bind: (...values) => trackedStatement(statement.bind(...values)),
      first: <T>(columnName?: string) => track(() => statement.first<T>(columnName)),
      all: <T>() => track(() => statement.all<T>()),
      run: () => track(() => statement.run()),
    };
  }
  vi.spyOn(db, "prepare").mockImplementation((query) => trackedStatement(prepare(query)));
  vi.spyOn(db, "transaction").mockImplementation(
    <T>(callback: (tx: DatabaseExecutor) => Promise<T>) => track(() => transaction(callback))
  );
  const audit = AuditService.prototype.logSystemWithin;
  vi.spyOn(AuditService.prototype, "logSystemWithin").mockImplementation(function <T>(
    this: AuditService,
    work: (tx: DatabaseClient) => Promise<{ entry: SystemAuditLogEntry | null; result: T }>
  ) {
    const original = audit.bind(this);
    return track(() => original<T>(work));
  });

  async function drain(work: Promise<void>): Promise<void> {
    let settled = false;
    const completion = work.finally(() => {
      settled = true;
    });
    while (!settled) {
      await yieldIo();
      if (databaseWork !== 0 || waits.length === 0) continue;
      const next = Math.min(...waits.map((wait) => wait.due));
      vi.setSystemTime(next);
      const due = waits.filter((wait) => wait.due === next);
      for (const wait of due) {
        waits.splice(waits.indexOf(wait), 1);
        wait.resolve();
      }
    }
    await completion;
    expect(waits).toEqual([]);
  }
  return { delay, drain };
}

async function seedQueue() {
  await seedTestDatabase(env);
  const db = getDb(env);
  await seedOrganizationMembers(db, { organization, members: [member] });
  const projects = await seedDefaultProjects(db, {
    organizationId: organization.id,
    createdBy: member.userId,
    members: [member.userId],
  });
  const projectId = projects.sandbox.id;
  await db.execute(
    `INSERT INTO custody_configs
       (id, organization_id, project_id, provider, config_encrypted)
     VALUES ('cfg_capacity', ?, ?, 'fireblocks', 'unused')`,
    [organization.id, projectId]
  );
  await db.execute(
    `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
     VALUES ('cw_capacity', 'cfg_capacity', 'fb_capacity', ?)`,
    [TEST_CUSTODY_PUBLIC_KEY]
  );
  await db.execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, custody_wallet_id, wallet_id, source_address,
        destination_address, token, amount, type, direction, status, provider_reference,
        provider_data, initiated_by_principal, created_at, updated_at)
     SELECT 'capacity_' || lpad(n::text, 3, '0'), ?, ?, 'cw_capacity', 'fb_capacity', ?, ?,
            'SOL', '1', 'transfer', 'outbound', 'processing', 'fb_capacity_' || lpad(n::text, 3, '0'),
            ?::jsonb, ?::jsonb, ?, ? FROM generate_series(1, ?) n`,
    [
      organization.id,
      projectId,
      TEST_CUSTODY_PUBLIC_KEY,
      TEST_CUSTODY_PUBLIC_KEY,
      JSON.stringify({ fireblocksTransfer: binding }),
      JSON.stringify({ kind: "api_key", apiKeyId: "key_capacity" }),
      new Date(START - MINUTE).toISOString(),
      new Date(START - MINUTE).toISOString(),
      ROWS,
    ]
  );
  const ledger = systemProposalLedger(env);
  const ids = Array.from(
    { length: ROWS },
    (_, index) => `capacity_${String(index + 1).padStart(3, "0")}`
  );
  for (const id of ids) {
    const transfer = required(
      await ledger.repo.getTransferById({
        transferId: id,
        organizationId: organization.id,
        projectId,
      })
    );
    await ledger.proposals.ensureForTransfer({
      transfer,
      provider: "fireblocks",
      binding,
      state: {
        ...createCustodyProposalState(),
        providerPhase: "pending",
        providerTransactionId: `fb_${id}`,
        providerStatus: "PENDING_AUTHORIZATION",
        submissionStartedAt: new Date(START - MINUTE).toISOString(),
      },
      now: new Date(START).toISOString(),
    });
  }
  const revoked = new Set(ids.slice(0, REVOKED));
  await db.execute(
    `UPDATE custody_proposals SET recheck_requested_at = ?
      WHERE organization_id = ? AND payment_transfer_id <= 'capacity_050'`,
    [new Date(START).toISOString(), organization.id]
  );
  return { ledger, projectId, ids, revoked };
}

function pending(id: string): FireblocksTransferResult {
  return {
    id: `fb_${id}`,
    externalTxId: id,
    operation: "TRANSFER",
    assetId: binding.assetId,
    source: { type: "VAULT_ACCOUNT", id: binding.vaultAccountId },
    status: "PENDING_AUTHORIZATION",
    subStatus: undefined,
    txHash: undefined,
    destinationAddress: undefined,
    amountInfo: undefined,
    feeCurrency: undefined,
    feeInfo: undefined,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("custody recovery capacity", () => {
  it.each([PROVIDER_MS, 10_000])(
    "measures custody latency under %ims provider I/O, CAS contention and overlapping workers",
    async (providerMs) => {
      expect(custodyProposalsCron.schedule).toBe("* * * * *");
      const { ledger, projectId, ids, revoked } = await seedQueue();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
      const clock = capacityClock();
      const warnings = vi.spyOn(rootLogger, "warn");
      const runScope = new AsyncLocalStorage<Run>();
      const contended = new Set<string>();
      const visited = new Set<string>();
      const cancelled = new Map<string, number[]>();
      const runs: Run[] = [];
      let globalProviderActive = 0;
      let globalProviderPeak = 0;
      const run = () => required(runScope.getStore());
      async function providerRead() {
        const current = run();
        current.providerActive++;
        globalProviderActive++;
        current.providerPeak = Math.max(current.providerPeak, current.providerActive);
        globalProviderPeak = Math.max(globalProviderPeak, globalProviderActive);
        try {
          await clock.delay(providerMs);
        } finally {
          current.providerActive--;
          globalProviderActive--;
        }
      }
      vi.spyOn(signer, "createOrgTransferProposalRecovery").mockImplementation(async () => {
        let transferId: string | null = null;
        return {
          read: async (id) => {
            transferId = id;
            const current = run();
            current.reads.add(id);
            if (!current.localCharged.has(id)) {
              current.localCharged.add(id);
              // Aggregate credential/admission/DB/audit budget, including a CAS retry.
              await clock.delay(LOCAL_ROW_MS);
            }
            await providerRead();
            visited.add(id);
            if (revoked.has(id) && !contended.has(id)) {
              contended.add(id);
              const identity = { transferId: id, organizationId: organization.id, projectId };
              const row = required(await ledger.repo.getTransferById(identity));
              const proposal = required(await ledger.proposals.getForTransfer(identity));
              const concurrent = await applyProposalObservation(
                ledger,
                row,
                pending(id),
                Date.now(),
                proposal
              );
              expect(concurrent.written).toBe(true);
            }
            return pending(id);
          },
          admit: async () => {
            if (revoked.has(required(transferId))) {
              throw new ProposalAdmissionRefusedError("principal_not_live", forbidden("Revoked"));
            }
          },
          cancel: async (id) => {
            await providerRead(); // Required fresh bound detail GET.
            const attempts = cancelled.get(id);
            if (attempts === undefined) cancelled.set(id, [Date.now()]);
            else attempts.push(Date.now());
            await providerRead(); // Cancel POST, acknowledged after one second.
            return true;
          },
        } satisfies CustodyProposalRecovery;
      });

      function startRun() {
        const current: Run = {
          reads: new Set(),
          localCharged: new Set(),
          providerActive: 0,
          providerPeak: 0,
          startedAt: Date.now(),
          finishedAt: 0,
        };
        runs.push(current);
        return runScope.run(current, async () => {
          await clock.delay(BATCH_MS);
          await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
            runWithSystemDatabaseIdentity("cron:reconcile-custody-proposals", () =>
              custodyProposalsCron.run(env)
            )
          );
          current.finishedAt = Date.now();
        });
      }

      // A wake just missed its slot. Two ordinary runs establish the worst priority delay.
      for (let tick = 1; tick <= 12 && visited.size < ROWS; tick++) {
        vi.setSystemTime(START + tick * MINUTE);
        const primary = startRun();
        await clock.drain(primary);
        if (providerMs > PROVIDER_MS) {
          expect(tick).toBe(1);
          expect(cancelled.size).toBeGreaterThan(0);
          expect(Math.max(...[...cancelled.values()].flat()) - START).toBeGreaterThan(180_000);
          expect(required(runs[0]).finishedAt).toBeGreaterThan(START + 180_000);
          return;
        }
        if (tick === 2) {
          expect(cancelled.size).toBe(REVOKED);
          expect(Math.max(...[...cancelled.values()].flat()) - START).toBeLessThanOrEqual(180_000);
        }
      }
      expect(visited).toEqual(new Set(ids));
      expect(Date.now() - START).toBeLessThanOrEqual(12 * MINUTE);
      // A second worker instance may overlap; its five slots are a separate bound.
      vi.setSystemTime(START + 13 * MINUTE);
      await clock.drain(Promise.all([startRun(), startRun()]).then(() => undefined));
      const overlapping = runs.slice(-2);
      expect(overlapping.map((current) => current.reads.size)).toEqual([50, 50]);
      expect(new Set(overlapping.flatMap((current) => [...current.reads])).size).toBe(100);
      const [first, second] = overlapping.map((current) => current.reads);
      expect([...required(first)].filter((id) => required(second).has(id))).toEqual([]);
      expect(warnings).not.toHaveBeenCalled();
      expect(contended.size).toBe(REVOKED);
      expect([...cancelled.keys()].sort()).toEqual([...revoked].sort());
      expect([...cancelled.values()].every((attempts) => attempts.length === 1)).toBe(true);
      expect(runs.every((current) => current.reads.size <= 50 && current.providerPeak <= 5)).toBe(
        true
      );
      for (const [index, current] of runs.entries()) {
        expect(
          current.finishedAt - current.startedAt,
          `run ${index}: ${JSON.stringify(runs.map((value) => value.finishedAt - value.startedAt))}`
        ).toBeLessThanOrEqual(55_000);
      }
      expect(globalProviderPeak).toBeGreaterThan(5);
      expect(globalProviderPeak).toBeLessThanOrEqual(10);
      expect(globalProviderActive).toBe(0);
    },
    30_000
  );
});
