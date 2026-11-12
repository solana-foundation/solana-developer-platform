import assert from "node:assert/strict";
import {
  type CustodyProposalState,
  createCustodyProposalState,
} from "@sdp/types/custody-proposals";
import type { PaymentTransferStatus } from "@sdp/types/payments";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithoutDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import type { MoneyPrincipal } from "@/lib/money-principal";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { env } from "@/test/helpers/env";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { holdTransaction, untilLockWaiters } from "@/test/helpers/row-locks";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  CustodyProposalIdentity,
  CustodyProposalsRepository,
} from "./custody-proposals.repository";
import { createPostgresCustodyProposalsRepository } from "./custody-proposals.repository.postgres";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";
import {
  CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS,
  requestPendingProposalRecovery,
} from "./proposal-recovery.repository";

const ORGANIZATION = { id: "org_custody_proposals", slug: "custody-proposals" };
const FOREIGN_ORGANIZATION = {
  id: "org_custody_proposals_foreign",
  slug: "custody-proposals-foreign",
};
const MEMBER = organizationMember("custody_proposals", "admin");
const FOREIGN_MEMBER = organizationMember("custody_proposals_foreign", "admin");
const PRINCIPAL = { kind: "api_key", apiKeyId: "key_custody_proposals" } as const;
const NOW = "2026-11-11T10:00:00.000Z";
const BEFORE = "2026-11-11T09:59:00.000Z";
const BINDING = {
  version: 1,
  provider: "fireblocks",
  connectionId: "connection_proposals",
  accountFingerprint: "account_fingerprint",
  vaultAccountId: "vault_proposals",
  assetId: "SOL_TEST",
};
const LEGACY_BINDING = {
  connectionId: BINDING.connectionId,
  accountFingerprint: BINDING.accountFingerprint,
  vaultAccountId: BINDING.vaultAccountId,
  assetId: BINDING.assetId,
};
let projectId: string;
let productionProjectId: string;
let foreignProjectId: string;
let repo: CustodyProposalsRepository;

function identity(transferId: string): CustodyProposalIdentity {
  return { transferId, organizationId: ORGANIZATION.id, projectId };
}

function pendingState(): CustodyProposalState {
  return {
    ...createCustodyProposalState(),
    providerPhase: "pending",
    providerTransactionId: "fireblocks_tx",
    providerStatus: "PENDING_AUTHORIZATION",
    submissionStartedAt: BEFORE,
  };
}

async function seedTransfer(input: {
  id: string;
  organizationId?: string;
  projectId?: string;
  principal?: MoneyPrincipal | null;
  providerReference?: string;
  status?: PaymentTransferStatus;
  providerData?: Record<string, unknown>;
  createdAt?: string;
}) {
  const db = getDb(env);
  const principal = input.principal === undefined ? PRINCIPAL : input.principal;
  await db.execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, source_address,
        destination_address, token, amount, type, direction, status,
        created_at, updated_at, provider_data, initiated_by_principal, provider_reference)
     VALUES (?, ?, ?, 'provider-wallet', 'Source', 'Destination', 'SOL', '1',
             'transfer', 'outbound', ?, ?, ?, ?::jsonb, ?::jsonb, ?)`,
    [
      input.id,
      input.organizationId ?? ORGANIZATION.id,
      input.projectId ?? projectId,
      input.status ?? "processing",
      input.createdAt ?? BEFORE,
      input.createdAt ?? BEFORE,
      JSON.stringify({ fireblocksTransfer: LEGACY_BINDING, ...input.providerData }),
      principal === null ? null : JSON.stringify(principal),
      input.providerReference ?? null,
    ]
  );
  const transfer = await createPostgresPaymentsRepository(db).getTransferById({
    transferId: input.id,
    organizationId: input.organizationId ?? ORGANIZATION.id,
    projectId: input.projectId ?? projectId,
  });
  assert(transfer);
  return transfer;
}

async function seedProposal(id: string, state = pendingState()) {
  const transfer = await seedTransfer({ id });
  const proposal = await repo.ensureForTransfer({
    transfer,
    provider: "fireblocks",
    binding: BINDING,
    state,
    now: BEFORE,
  });
  return { transfer, proposal };
}

async function flag(id: string, at = BEFORE): Promise<void> {
  await getDb(env).execute(
    "UPDATE custody_proposals SET recheck_requested_at = ? WHERE payment_transfer_id = ?",
    [at, id]
  );
}

const claimInput = { environment: "sandbox", now: NOW, limit: 50 } as const;

describe("CustodyProposalsRepository", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [MEMBER] });
    await seedOrganizationMembers(db, {
      organization: FOREIGN_ORGANIZATION,
      members: [FOREIGN_MEMBER],
    });
    const projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: MEMBER.userId,
      members: [MEMBER.userId],
    });
    projectId = projects.sandbox.id;
    productionProjectId = projects.production.id;
    const foreign = await seedDefaultProjects(db, {
      organizationId: FOREIGN_ORGANIZATION.id,
      createdBy: FOREIGN_MEMBER.userId,
      members: [FOREIGN_MEMBER.userId],
    });
    foreignProjectId = foreign.sandbox.id;
    repo = createPostgresCustodyProposalsRepository(db);
  });

  it("creates once and refuses rebinding, including when JSON key order changes", async () => {
    const { transfer, proposal } = await seedProposal("immutable");
    expect(
      await repo.ensureForTransfer({
        transfer,
        provider: "fireblocks",
        binding: { ...BINDING },
        state: createCustodyProposalState(),
        now: NOW,
      })
    ).toEqual(proposal);
    await expect(
      repo.ensureForTransfer({
        transfer,
        provider: "fireblocks",
        binding: { ...BINDING, connectionId: "rotated" },
        state: pendingState(),
        now: NOW,
      })
    ).rejects.toThrow("immutable binding");
    expect((await repo.getForTransfer(identity("immutable")))?.binding).toEqual(BINDING);
    await expect(
      repo.ensureForTransfer({
        transfer: {
          ...transfer,
          organization_id: FOREIGN_ORGANIZATION.id,
          project_id: foreignProjectId,
        },
        provider: "fireblocks",
        binding: BINDING,
        state: pendingState(),
        now: NOW,
      })
    ).rejects.toThrow("does not match");
  });

  it("guards reads and transitions by payment, organization and project", async () => {
    const { proposal } = await seedProposal("tenant");
    for (const other of [
      { ...identity("tenant"), transferId: "other_parent" },
      { ...identity("tenant"), organizationId: FOREIGN_ORGANIZATION.id },
      { ...identity("tenant"), projectId: productionProjectId },
    ]) {
      expect(await repo.getForTransfer(other)).toBeNull();
      expect(
        await repo.transition({
          ...other,
          expectedVersion: proposal.version,
          event: { type: "admission_refused", at: NOW, reason: "revoked", message: "Revoked" },
        })
      ).toBeNull();
    }
    const scoped = createPostgresCustodyProposalsRepository(
      getDb(env),
      createTenantScope({ organizationId: ORGANIZATION.id, projectId })
    );
    await expect(
      scoped.getForTransfer({ ...identity("tenant"), projectId: productionProjectId })
    ).rejects.toBeInstanceOf(TenantScopeViolationError);
    expect((await repo.getForTransfer(identity("tenant")))?.version).toBe(0);
  });

  it("lets only one concurrent CAS emit effects and keeps refusal immutable", async () => {
    const { proposal } = await seedProposal("cas");
    const results = await Promise.all(
      ["revoked", "grant_removed"].map((reason) =>
        repo.transition({
          ...identity("cas"),
          expectedVersion: proposal.version,
          event: { type: "admission_refused", at: NOW, reason, message: reason },
        })
      )
    );
    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.effects).toContainEqual({ type: "audit", event: "proposal_refused" });
    const after = await repo.getForTransfer(identity("cas"));
    expect(after?.version).toBe(1);
    expect(after?.state.refusal?.reason).toBe(winners[0]?.proposal.state.refusal?.reason);
    expect(
      await repo.transition({
        ...identity("cas"),
        expectedVersion: 0,
        event: { type: "cancel_requested", at: NOW },
      })
    ).toBeNull();
  });

  it("increments the version for a cancellation retry even when state is unchanged", async () => {
    const { proposal } = await seedProposal("cancel_retry");
    const refused = await repo.transition({
      ...identity("cancel_retry"),
      expectedVersion: proposal.version,
      event: { type: "admission_refused", at: NOW, reason: "revoked", message: "Revoked" },
    });
    assert(refused);
    const requested = await repo.transition({
      ...identity("cancel_retry"),
      expectedVersion: refused.proposal.version,
      event: { type: "cancel_requested", at: NOW },
    });
    assert(requested);
    const retries = await Promise.all(
      [1, 2].map(() =>
        repo.transition({
          ...identity("cancel_retry"),
          expectedVersion: requested.proposal.version,
          event: { type: "cancel_requested", at: NOW },
        })
      )
    );
    expect(retries.filter(Boolean)).toHaveLength(1);
    expect((await repo.getForTransfer(identity("cancel_retry")))?.version).toBe(
      requested.proposal.version + 1
    );
  });

  it("rolls back the lifecycle CAS with the surrounding payment/audit transaction", async () => {
    const { proposal } = await seedProposal("rollback");
    await expect(
      getDb(env).transaction(async (tx) => {
        const transactional = createPostgresCustodyProposalsRepository(tx);
        const written = await transactional.transition({
          ...identity("rollback"),
          expectedVersion: proposal.version,
          event: { type: "admission_refused", at: NOW, reason: "revoked", message: "Revoked" },
        });
        expect(written?.proposal.version).toBe(1);
        throw new Error("audit write failed");
      })
    ).rejects.toThrow("audit write failed");
    expect(await repo.getForTransfer(identity("rollback"))).toEqual(proposal);
  });

  it("keeps viewer throttling independent from authority requests and worker scheduling", async () => {
    await seedProposal("viewed");
    await flag("viewed");
    const reads = await Promise.all(
      [1, 2].map(() => repo.claimForPoll({ ...identity("viewed"), now: NOW, polledBefore: BEFORE }))
    );
    expect(reads.filter(Boolean)).toHaveLength(1);
    expect(await repo.getForTransfer(identity("viewed"))).toMatchObject({
      recheck_requested_at: BEFORE,
      last_checked_at: null,
      next_check_at: BEFORE,
    });
    expect((await repo.claimDue(claimInput)).map((row) => row.payment_transfer_id)).toEqual([
      "viewed",
    ]);
    expect(await repo.claimDue(claimInput)).toEqual([]);
  });

  it("prioritizes revocations but reserves fair progress for ordinary proposals", async () => {
    for (const id of ["a_flag", "b_flag", "c_flag", "d_flag", "z_ordinary"]) await seedProposal(id);
    for (const id of ["a_flag", "b_flag", "c_flag", "d_flag"]) await flag(id);
    const page = await repo.claimDue({ ...claimInput, limit: 4 });
    expect(page).toHaveLength(4);
    expect(page.filter((row) => row.payment_transfer_id.endsWith("_flag"))).toHaveLength(3);
    expect(page.at(-1)?.payment_transfer_id).toBe("z_ordinary");
    const remaining = await repo.claimDue(claimInput);
    expect(remaining).toHaveLength(1);
    expect(new Set([...page, ...remaining].map((row) => row.payment_transfer_id)).size).toBe(5);
  });

  it("gives concurrent workers disjoint pages and skips locked proposals", async () => {
    for (const id of ["a", "b", "c", "d", "locked"]) await seedProposal(id);
    const lock = await holdTransaction(getDb(env), async (tx) => {
      await tx.execute(
        "SELECT id FROM custody_proposals WHERE payment_transfer_id = 'locked' FOR UPDATE"
      );
    });
    try {
      const pages = await Promise.all([
        repo.claimDue({ ...claimInput, limit: 2 }),
        repo.claimDue({ ...claimInput, limit: 2 }),
      ]);
      expect(pages.map((rows) => rows.length)).toEqual([2, 2]);
      expect(pages.flatMap((rows) => rows.map((row) => row.payment_transfer_id)).sort()).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    } finally {
      await lock.commit();
    }
  });

  it("preserves a revocation that waits behind an in-flight worker claim", async () => {
    await seedProposal("late_wake");
    const db = getDb(env);
    const lock = await holdTransaction(db, async (tx) => {
      await createPostgresCustodyProposalsRepository(tx).claimDue(claimInput);
    });
    const requested = requestPendingProposalRecovery(db, {
      organizationId: ORGANIZATION.id,
      projectId,
      principal: PRINCIPAL,
      now: BEFORE,
    });
    try {
      await untilLockWaiters(db, { fragment: "SET recheck_requested_at", count: 1 });
    } finally {
      await lock.commit();
    }
    await requested;
    expect(await repo.getForTransfer(identity("late_wake"))).toMatchObject({
      recheck_requested_at: BEFORE,
      last_checked_at: NOW,
    });
    expect((await repo.claimDue(claimInput)).map((row) => row.payment_transfer_id)).toEqual([
      "late_wake",
    ]);
  });

  it("keeps terminal critical alerts outside the active proposal queue", async () => {
    const state = {
      ...pendingState(),
      providerPhase: "completed",
      authorizationState: "committed_after_refusal",
      refusal: { at: BEFORE, reason: "revoked", message: "Revoked" },
    } as const;
    const { proposal } = await seedProposal("completed", state);
    expect(await repo.claimDue(claimInput)).toEqual([]);
    expect(
      (await repo.listUnalerted({ environment: "sandbox", limit: 10 })).map((row) => row.id)
    ).toEqual([proposal.id]);
    const delivered = await repo.transition({
      ...identity("completed"),
      expectedVersion: proposal.version,
      event: { type: "alert_delivered", at: NOW },
    });
    expect(delivered?.proposal.state.alertedAt).toBe(NOW);
    expect(await repo.listUnalerted({ environment: "sandbox", limit: 10 })).toEqual([]);
  });

  it("requires named system authority for queue, outbox and rolling adoption", async () => {
    const scoped = createPostgresCustodyProposalsRepository(
      getDb(env),
      createTenantScope({ organizationId: ORGANIZATION.id, projectId })
    );
    for (const repository of [repo, scoped]) {
      const operations: readonly (() => Promise<unknown>)[] = [
        () => repository.claimDue(claimInput),
        () => repository.listUnalerted({ environment: "sandbox", limit: 10 }),
        () => repository.adoptLegacyTransfers(claimInput),
      ];
      for (const operation of operations) {
        await expect(
          runWithTenantDatabaseIdentity({ organizationId: ORGANIZATION.id }, operation)
        ).rejects.toBeInstanceOf(TenantScopeViolationError);
        await expect(runWithoutDatabaseIdentity("proposal-test", operation)).rejects.toBeInstanceOf(
          TenantScopeViolationError
        );
      }
    }
  });

  it("continues adopting old-revision writes after the first recovery pass", async () => {
    const legacy = {
      fireblocksSubmissionStartedAt: BEFORE,
      fireblocksStatus: "PENDING_AUTHORIZATION",
    };
    await seedTransfer({
      id: "legacy_first",
      providerReference: "legacy_tx_1",
      providerData: legacy,
    });
    await seedTransfer({
      id: "legacy_production",
      projectId: productionProjectId,
      providerReference: "production_tx",
      providerData: legacy,
    });
    expect(await repo.adoptLegacyTransfers(claimInput)).toBe(1);
    expect(await repo.getForTransfer(identity("legacy_first"))).toMatchObject({
      binding: BINDING,
      state: { providerPhase: "pending", providerTransactionId: "legacy_tx_1" },
    });
    await seedTransfer({
      id: "legacy_late",
      providerReference: "legacy_tx_2",
      providerData: legacy,
      principal: null,
    });
    expect(await repo.adoptLegacyTransfers(claimInput)).toBe(1);
    expect(await repo.adoptLegacyTransfers(claimInput)).toBe(0);
    expect(await repo.getForTransfer(identity("legacy_late"))).toMatchObject({
      state: { providerPhase: "pending" },
    });
  });

  it("discovers preclaim crashes after the grace without preempting a fresh payment", async () => {
    const cutoff = Date.parse(NOW) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS;
    await seedTransfer({
      id: "crashed_before_proposal",
      createdAt: new Date(cutoff).toISOString(),
    });
    await seedTransfer({ id: "fresh_unclaimed", createdAt: new Date(cutoff + 1).toISOString() });
    await seedTransfer({
      id: "production_unclaimed",
      projectId: productionProjectId,
      createdAt: new Date(cutoff).toISOString(),
    });
    await seedTransfer({ id: "signed_locally", createdAt: new Date(cutoff).toISOString() });
    await getDb(env).execute(
      "UPDATE payment_transfers SET provider_data = '{}'::jsonb WHERE id = 'signed_locally'"
    );

    expect(await repo.adoptLegacyTransfers(claimInput)).toBe(1);
    expect(await repo.getForTransfer(identity("crashed_before_proposal"))).toMatchObject({
      state: { providerPhase: "unsent", providerTransactionId: null, submissionStartedAt: null },
    });
    expect(await repo.getForTransfer(identity("fresh_unclaimed"))).toBeNull();
    expect((await repo.claimDue(claimInput)).map((row) => row.payment_transfer_id)).toEqual([
      "crashed_before_proposal",
    ]);
    expect(
      await repo.adoptLegacyTransfers({
        ...claimInput,
        now: new Date(Date.parse(NOW) + 1).toISOString(),
      })
    ).toBe(1);
    expect(await repo.getForTransfer(identity("fresh_unclaimed"))).not.toBeNull();
    expect(await repo.getForTransfer(identity("signed_locally"))).toBeNull();
    expect(
      await repo.getForTransfer({
        ...identity("production_unclaimed"),
        projectId: productionProjectId,
      })
    ).toBeNull();
  });

  it("advances an already adopted unsent intent when an older image later submits", async () => {
    const { proposal } = await seedProposal("old_writer_started", createCustodyProposalState());
    await getDb(env).execute(
      `UPDATE payment_transfers SET provider_reference = 'later_tx',
         provider_data = provider_data || ?::jsonb WHERE id = 'old_writer_started'`,
      [
        JSON.stringify({
          fireblocksSubmissionStartedAt: BEFORE,
          fireblocksStatus: "PENDING_AUTHORIZATION",
        }),
      ]
    );
    expect(await repo.adoptLegacyTransfers(claimInput)).toBe(1);
    const current = await repo.getForTransfer(identity("old_writer_started"));
    expect(current).toMatchObject({
      id: proposal.id,
      version: proposal.version + 1,
      state: { providerPhase: "pending", providerTransactionId: "later_tx" },
    });
    expect(await repo.adoptLegacyTransfers(claimInput)).toBe(0);
  });

  it.each([
    { status: "confirmed", providerStatus: "COMPLETED", phase: "completed" },
    { status: "failed", providerStatus: "FAILED", phase: "failed" },
  ] as const)(
    "absorbs an old writer's $status outcome after unsent adoption",
    async ({ status, providerStatus, phase }) => {
      const { proposal } = await seedProposal("old_writer_terminal", createCustodyProposalState());
      await getDb(env).execute(
        `UPDATE payment_transfers SET status = ?, provider_reference = 'terminal_tx',
         provider_data = provider_data || ?::jsonb WHERE id = 'old_writer_terminal'`,
        [
          status,
          JSON.stringify({
            fireblocksSubmissionStartedAt: BEFORE,
            fireblocksStatus: providerStatus,
          }),
        ]
      );
      expect(await repo.adoptLegacyTransfers(claimInput)).toBe(1);
      expect(await repo.getForTransfer(identity("old_writer_terminal"))).toMatchObject({
        id: proposal.id,
        version: proposal.version + 1,
        binding: BINDING,
        state: {
          providerPhase: phase,
          providerTransactionId: "terminal_tx",
          authorizationState: "authorized",
        },
      });
      expect(await repo.claimDue(claimInput)).toEqual([]);
      expect(await repo.adoptLegacyTransfers(claimInput)).toBe(0);
    }
  );

  it("absorbs an old writer's later submission only while canonical state is still unsent", async () => {
    const { transfer, proposal } = await seedProposal("overlap", createCustodyProposalState());
    await getDb(env).execute(
      "UPDATE payment_transfers SET provider_reference = 'old_writer_tx' WHERE id = 'overlap'"
    );
    const advanced = { ...pendingState(), providerTransactionId: "old_writer_tx" };
    const synchronized = await repo.ensureForTransfer({
      transfer,
      provider: "fireblocks",
      binding: BINDING,
      state: advanced,
      now: NOW,
    });
    expect(synchronized.state).toEqual(advanced);
    expect(synchronized.version).toBe(proposal.version + 1);
    const refused = await repo.transition({
      ...identity("overlap"),
      expectedVersion: synchronized.version,
      event: { type: "admission_refused", at: NOW, reason: "revoked", message: "Revoked" },
    });
    assert(refused);
    const preserved = await repo.ensureForTransfer({
      transfer,
      provider: "fireblocks",
      binding: BINDING,
      state: pendingState(),
      now: NOW,
    });
    expect(preserved).toEqual(refused.proposal);
  });
});
