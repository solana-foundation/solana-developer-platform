import assert from "node:assert/strict";
import {
  CUSTODY_PROPOSAL_CANCELLATION_RETRY_INTERVAL_MS,
  type CustodyProposalState,
  createCustodyProposalState,
} from "@sdp/types/custody-proposals";
import type { PaymentTransferStatus } from "@sdp/types/payments";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithoutDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import type { MoneyPrincipal } from "@/lib/money-principal";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
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

async function seedSigning(tag = "signing", ownerProjectId = projectId) {
  const walletId = `cw_${tag}`;
  const db = getDb(env);
  await seedUnreadPrivyWallet(db, {
    organizationId: ORGANIZATION.id,
    projectId: ownerProjectId,
    createdBy: MEMBER.userId,
    custodyWalletId: walletId,
    walletId: `provider_${tag}`,
    publicKey: `Source_${tag}`,
  });
  const scope = { organizationId: ORGANIZATION.id, projectId: ownerProjectId };
  const id = await repo.createSigning({
    ...scope,
    provider: "privy",
    connectionId: `cconn_${walletId}`,
    walletId: `provider_${tag}`,
    binding: { connectionId: `cconn_${walletId}`, sourceAddress: `Source_${tag}` },
    operation: "SIGN_TRANSACTION",
    requestId: `request_${tag}`,
  });
  await db.execute("UPDATE custody_proposals SET next_check_at = ? WHERE id = ?", [BEFORE, id]);
  return { ...scope, proposalId: id };
}

function signingObservation(phase: "pending" | "completed" | "cancelled" = "pending") {
  return {
    type: "observed" as const,
    at: NOW,
    phase,
    providerTransactionId: "signing_provider_tx",
    providerStatus: phase === "completed" ? "SIGNED" : "PENDING_AUTHORIZATION",
    providerSubStatus: null,
  };
}

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

  it("stores sign-only requests in the canonical table without a payment or legacy row", async () => {
    const input = await seedSigning();
    const row = await repo.requireSigning(input);
    expect(row).toMatchObject({
      kind: "signing",
      payment_transfer_id: null,
      provider: "privy",
      operation: "SIGN_TRANSACTION",
      request_id: "request_signing",
      finished_at: null,
      binding: { connectionId: "cconn_cw_signing", sourceAddress: "Source_signing" },
      state: { providerPhase: "submitting", authorizationState: "authorized" },
    });
    expect(await getDb(env).queryMany("SELECT id FROM fireblocks_signing_proposals")).toEqual([]);
    expect(
      await repo.listSigning({
        organizationId: input.organizationId,
        projectId,
        walletId: row.custody_wallet_id,
        offset: 0,
      })
    ).toEqual([row]);
    await expect(
      repo.createSigning({
        organizationId: input.organizationId,
        projectId,
        provider: "fireblocks",
        connectionId: "cconn_cw_signing",
        walletId: "provider_signing",
        binding: {},
        operation: "RAW",
      })
    ).rejects.toThrow("wallet is unavailable");
  });

  it("scopes every signing read and mutation to its recorded tenant", async () => {
    const input = await seedSigning();
    const wrong = { ...input, projectId: productionProjectId };
    expect(await repo.getSigning(wrong)).toBeNull();
    expect(await repo.requestSigningCancellation(wrong)).toBe(false);
    expect(await repo.claimSigningPoll(wrong)).toBe(false);
    const scoped = createPostgresCustodyProposalsRepository(getDb(env), createTenantScope(input));
    await expect(scoped.getSigning(wrong)).rejects.toBeInstanceOf(TenantScopeViolationError);
    expect((await repo.requireSigning(input)).version).toBe(0);
  });

  it("keeps a pre-acceptance cancellation sticky when a signature arrives later", async () => {
    const input = await seedSigning();
    expect(await repo.requestSigningCancellation(input)).toBe(true);
    expect(await repo.observeSigning({ ...input, event: signingObservation("completed") })).toBe(
      false
    );
    const row = await repo.requireSigning(input);
    expect(row.state).toMatchObject({
      providerPhase: "completed",
      authorizationState: "committed_after_refusal",
      refusal: { reason: "cancellation_requested" },
    });
    expect(row.finished_at).toBe(NOW);
    expect(await repo.listUnalerted(claimInput)).toContainEqual(row);
    expect(
      await repo.transitionSigning({
        ...input,
        expectedVersion: row.version,
        event: { type: "alert_delivered", at: NOW },
      })
    ).toMatchObject({ state: { authorizationState: "refusal_alerted" } });
    expect(await repo.listUnalerted(claimInput)).toEqual([]);
  });

  it("lets cancellation or signature delivery win a race without authorizing both", async () => {
    const input = await seedSigning();
    const [cancelled, deliverable] = await Promise.all([
      repo.requestSigningCancellation(input),
      repo.observeSigning({ ...input, event: signingObservation("completed") }),
    ]);
    expect(cancelled && deliverable).toBe(false);
    expect(cancelled || deliverable).toBe(true);
    const row = await repo.requireSigning(input);
    expect(row.state.authorizationState).toBe(cancelled ? "committed_after_refusal" : "authorized");
  });

  it("retains the first terminal signing fact while accepting an equivalent provider observation", async () => {
    const input = await seedSigning();
    expect(await repo.observeSigning({ ...input, event: signingObservation("completed") })).toBe(
      true
    );
    expect(
      await repo.observeSigning({
        ...input,
        event: { ...signingObservation("completed"), providerStatus: "COMPLETED" },
      })
    ).toBe(true);
    expect((await repo.requireSigning(input)).state.providerStatus).toBe("SIGNED");
    expect(await repo.observeSigning({ ...input, event: signingObservation("cancelled") })).toBe(
      false
    );
    expect(await repo.observeSigning({ ...input, event: signingObservation("pending") })).toBe(
      false
    );
    await expect(
      repo.observeSigning({
        ...input,
        event: { ...signingObservation("completed"), providerTransactionId: "different" },
      })
    ).rejects.toThrow("identity or outcome changed");
  });

  it("rejects stale signing versions and cancellation results for an older attempt", async () => {
    const input = await seedSigning();
    await repo.observeSigning({ ...input, event: signingObservation() });
    const pending = await repo.requireSigning(input);
    await repo.requestSigningCancellation(input);
    expect(
      await repo.transitionSigning({
        ...input,
        expectedVersion: pending.version,
        event: { type: "cancel_requested", at: NOW },
      })
    ).toBeNull();
    const first = await repo.transitionSigning({
      ...input,
      event: { type: "cancel_requested", at: NOW },
    });
    assert(first);
    const later = new Date(
      Date.parse(NOW) + CUSTODY_PROPOSAL_CANCELLATION_RETRY_INTERVAL_MS
    ).toISOString();
    await repo.transitionSigning({
      ...input,
      expectedCancelAttempt: 1,
      event: { type: "cancel_ambiguous", at: NOW },
    });
    await repo.transitionSigning({ ...input, event: { type: "cancel_requested", at: later } });
    expect(
      await repo.transitionSigning({
        ...input,
        expectedCancelAttempt: first.state.cancelAttempt,
        event: { type: "cancel_accepted", at: later },
      })
    ).toBeNull();
    expect((await repo.requireSigning(input)).state.cancelAttempt).toBe(2);
  });

  it("shares recovery scheduling across proposal kinds while retaining environment and principal scope", async () => {
    const signing = await seedSigning();
    await seedSigning("production_signing", productionProjectId);
    const { proposal } = await seedProposal("shared_transfer");
    const stats = await repo.stats(claimInput);
    expect(stats).toMatchObject({ pending: 2, transfers: 1, signing: 1 });
    expect(
      (await repo.claimDue({ ...claimInput, principal: PRINCIPAL })).map((row) => row.id)
    ).toEqual([proposal.id]);
    const rows = await repo.claimDue(claimInput);
    expect(rows.map((row) => row.id)).toEqual([signing.proposalId]);
    expect(await repo.claimDue(claimInput)).toEqual([]);
  });

  it("keeps signing viewer throttles separate from worker claims", async () => {
    const input = await seedSigning();
    expect(await repo.claimSigningPoll(input)).toBe(true);
    expect(await repo.claimSigningPoll(input)).toBe(false);
    expect((await repo.claimDue(claimInput)).map((row) => row.id)).toEqual([input.proposalId]);
    expect((await repo.requireSigning(input)).last_polled_at).not.toBeNull();
  });

  it("reports the latest worker or viewer poll clock in canonical backlog metrics", async () => {
    const input = await seedSigning();
    await getDb(env).execute(
      "UPDATE custody_proposals SET last_polled_at = ?, last_checked_at = ? WHERE id = ?",
      [BEFORE, NOW, input.proposalId]
    );
    expect((await repo.stats(claimInput)).oldestUnpolledAgeMs).toBe(0);
    await getDb(env).execute(
      "UPDATE custody_proposals SET last_polled_at = ?, last_checked_at = ? WHERE id = ?",
      [NOW, BEFORE, input.proposalId]
    );
    expect((await repo.stats(claimInput)).oldestUnpolledAgeMs).toBe(0);
  });

  it("rotates a 500-proposal mixed backlog within five bounded worker passes", async () => {
    const signing = await seedSigning("capacity");
    await seedProposal("capacity_transfer");
    await getDb(env).execute(
      `INSERT INTO custody_proposals
         (id, organization_id, project_id, custody_wallet_id, kind, operation, provider, binding,
          provider_phase, authorization_state, submission_started_at, next_check_at, created_at, updated_at)
       SELECT 'capacity_' || series, cp.organization_id, cp.project_id, cp.custody_wallet_id,
          cp.kind, cp.operation, cp.provider, cp.binding, cp.provider_phase, cp.authorization_state,
          cp.submission_started_at, cp.next_check_at, cp.created_at, cp.updated_at
       FROM custody_proposals cp CROSS JOIN generate_series(1, 498) series WHERE cp.id = ?`,
      [signing.proposalId]
    );
    expect(await repo.stats(claimInput)).toMatchObject({
      pending: 500,
      transfers: 1,
      signing: 499,
    });
    const seen = new Set<string>();
    for (let pass = 0; pass < 5; pass += 1) {
      const page = await repo.claimDue({
        ...claimInput,
        limit: 100,
        now: new Date(Date.parse(NOW) + pass * 30_000).toISOString(),
      });
      expect(page).toHaveLength(100);
      for (const row of page) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(500);
  });

  it("retains the payment age when adopting an old transfer", async () => {
    const createdAt = "2026-11-10T10:00:00.000Z";
    const transfer = await seedTransfer({ id: "historical", createdAt });
    const state = pendingState();
    const proposal = await repo.ensureForTransfer({
      transfer,
      provider: "fireblocks",
      binding: BINDING,
      state,
      now: NOW,
    });
    expect(proposal).toMatchObject({
      created_at: createdAt,
      updated_at: NOW,
      next_check_at: NOW,
      version: 0,
      state,
    });
    expect(await repo.getForTransfer(identity(transfer.id))).toEqual(proposal);
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

  it("keeps repeated refusal unchanged while rejecting a stale version", async () => {
    const { proposal } = await seedProposal("noop_refusal");
    const refused = await repo.transition({
      ...identity("noop_refusal"),
      expectedVersion: proposal.version,
      event: { type: "admission_refused", at: BEFORE, reason: "revoked", message: "Revoked" },
    });
    assert(refused);
    const event = {
      type: "admission_refused",
      at: NOW,
      reason: "grant_removed",
      message: "Grant removed",
    } as const;
    expect(
      await repo.transition({
        ...identity("noop_refusal"),
        expectedVersion: refused.proposal.version,
        event,
      })
    ).toEqual({ proposal: refused.proposal, effects: [] });
    expect(
      await repo.transition({
        ...identity("noop_refusal"),
        expectedVersion: proposal.version,
        event,
      })
    ).toBeNull();
    expect(await repo.getForTransfer(identity("noop_refusal"))).toEqual(refused.proposal);
  });

  it("advances repeated active observations so stale recovery work stays fenced", async () => {
    const { proposal } = await seedProposal("repeated_observation");
    let current = proposal;
    for (const at of [NOW, "2026-11-11T10:00:01.000Z"]) {
      const observed = await repo.transition({
        ...identity("repeated_observation"),
        expectedVersion: current.version,
        event: {
          type: "observed",
          at,
          phase: "pending",
          providerTransactionId: "fireblocks_tx",
          providerStatus: "PENDING_AUTHORIZATION",
          providerSubStatus: null,
        },
      });
      assert(observed);
      expect(observed.effects).toEqual([{ type: "payment_status", status: "processing" }]);
      expect(observed.proposal).toMatchObject({
        version: current.version + 1,
        state: current.state,
        updated_at: at,
      });
      current = observed.proposal;
    }
    expect(await repo.getForTransfer(identity("repeated_observation"))).toEqual(current);
  });

  it("enforces the cancellation cooldown and allows only one concurrent retry", async () => {
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
    expect(requested.proposal.state.cancelAttempt).toBe(1);
    expect(
      await repo.transition({
        ...identity("cancel_retry"),
        expectedVersion: requested.proposal.version,
        event: { type: "cancel_requested", at: NOW },
      })
    ).toBeNull();
    expect(await repo.getForTransfer(identity("cancel_retry"))).toEqual(requested.proposal);
    const retryAt = new Date(
      Date.parse(NOW) + CUSTODY_PROPOSAL_CANCELLATION_RETRY_INTERVAL_MS
    ).toISOString();
    const retries = await Promise.all(
      [1, 2].map(() =>
        repo.transition({
          ...identity("cancel_retry"),
          expectedVersion: requested.proposal.version,
          event: { type: "cancel_requested", at: retryAt },
        })
      )
    );
    expect(retries.filter(Boolean)).toHaveLength(1);
    expect(await repo.getForTransfer(identity("cancel_retry"))).toMatchObject({
      version: requested.proposal.version + 1,
      state: { cancelRequestedAt: retryAt, cancelAttempt: 2 },
    });
  });

  it("rolls back a cancellation attempt identity with its audit transaction", async () => {
    const { proposal } = await seedProposal("attempt_rollback");
    const refused = await repo.transition({
      ...identity("attempt_rollback"),
      expectedVersion: proposal.version,
      event: { type: "admission_refused", at: NOW, reason: "revoked", message: "Revoked" },
    });
    assert(refused);
    await expect(
      getDb(env).transaction(async (tx) => {
        const transactional = createPostgresCustodyProposalsRepository(tx);
        const requested = await transactional.transition({
          ...identity("attempt_rollback"),
          expectedVersion: refused.proposal.version,
          event: { type: "cancel_requested", at: NOW },
        });
        expect(requested?.proposal.state.cancelAttempt).toBe(1);
        throw new Error("audit write failed");
      })
    ).rejects.toThrow("audit write failed");
    expect(await repo.getForTransfer(identity("attempt_rollback"))).toEqual(refused.proposal);
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

  it.each(["viewer", "revocation"] as const)(
    "protects a fresh unsent payment adopted by a %s until its creator claims submission",
    async (adopter) => {
      const transfer = await seedTransfer({
        id: "mid_create",
        createdAt: new Date(
          Date.parse(NOW) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS + 1
        ).toISOString(),
      });
      if (adopter === "viewer") {
        await repo.ensureForTransfer({
          transfer,
          provider: "fireblocks",
          binding: BINDING,
          state: createCustodyProposalState(),
          now: NOW,
        });
      } else {
        await requestPendingProposalRecovery(getDb(env), {
          organizationId: ORGANIZATION.id,
          projectId,
          principal: PRINCIPAL,
          now: NOW,
        });
      }
      const proposal = await repo.getForTransfer(identity(transfer.id));
      assert(proposal);
      expect(proposal.state.providerPhase).toBe("unsent");
      const [poll, due] = await Promise.all([
        repo.claimForPoll({ ...identity(transfer.id), now: NOW, polledBefore: BEFORE }),
        repo.claimDue(claimInput),
      ]);
      expect(poll).toBeNull();
      expect(due).toEqual([]);
      expect(await repo.getForTransfer(identity(transfer.id))).toEqual(proposal);

      const claimed = await repo.transition({
        ...identity(transfer.id),
        expectedVersion: proposal.version,
        event: { type: "submission_claimed", at: NOW },
      });
      expect(claimed?.proposal.state.providerPhase).toBe("submitting");
      // Once the creator claims, both observation paths can recover immediately,
      // including a revocation queued while creation was still in progress.
      expect(
        await repo.claimForPoll({ ...identity(transfer.id), now: NOW, polledBefore: BEFORE })
      ).not.toBeNull();
      expect((await repo.claimDue(claimInput)).map((row) => row.payment_transfer_id)).toEqual([
        transfer.id,
      ]);
    }
  );

  it("recovers unsent payments at their original creation grace boundary", async () => {
    const transfer = await seedTransfer({
      id: "old_unsent",
      createdAt: new Date(Date.parse(NOW) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS).toISOString(),
    });
    await repo.ensureForTransfer({
      transfer,
      provider: "fireblocks",
      binding: BINDING,
      state: createCustodyProposalState(),
      now: NOW,
    });
    expect(
      await repo.claimForPoll({ ...identity(transfer.id), now: NOW, polledBefore: BEFORE })
    ).not.toBeNull();
    expect((await repo.claimDue(claimInput)).map((row) => row.payment_transfer_id)).toEqual([
      transfer.id,
    ]);
  });

  it("prioritizes revocations but reserves fair progress for ordinary proposals", async () => {
    for (const id of ["a_flag", "b_flag", "c_flag", "d_flag", "z_ordinary"]) await seedProposal(id);
    for (const id of ["a_flag", "b_flag", "c_flag", "d_flag"]) await flag(id);
    const page = await repo.claimDue({ ...claimInput, limit: 4 });
    expect(page).toHaveLength(4);
    expect(
      page.filter((row) => row.kind === "transfer" && row.payment_transfer_id.endsWith("_flag"))
    ).toHaveLength(3);
    expect(page.at(-1)?.payment_transfer_id).toBe("z_ordinary");
    const remaining = await repo.claimDue(claimInput);
    expect(remaining).toHaveLength(1);
    expect(new Set([...page, ...remaining].map((row) => row.payment_transfer_id)).size).toBe(5);
  });

  it("requeues only the named active proposal while preserving a concurrent authority wake", async () => {
    await seedProposal("retry");
    await seedProposal("terminal_retry", { ...pendingState(), providerPhase: "cancelled" });
    await repo.claimDue(claimInput);
    expect(await repo.claimDue(claimInput)).toEqual([]);
    await repo.requestRecheck({
      ...identity("retry"),
      organizationId: FOREIGN_ORGANIZATION.id,
      now: NOW,
    });
    await repo.requestRecheck({ ...identity("retry"), projectId: productionProjectId, now: NOW });
    expect((await repo.getForTransfer(identity("retry")))?.recheck_requested_at).toBeNull();
    await repo.requestRecheck({ ...identity("retry"), now: BEFORE });
    await repo.requestRecheck({ ...identity("retry"), now: NOW });
    expect((await repo.getForTransfer(identity("retry")))?.recheck_requested_at).toBe(BEFORE);
    await repo.requestRecheck({ ...identity("terminal_retry"), now: NOW });
    expect(
      (await repo.getForTransfer(identity("terminal_retry")))?.recheck_requested_at
    ).toBeNull();
    expect((await repo.claimDue(claimInput)).map((row) => row.payment_transfer_id)).toEqual([
      "retry",
    ]);
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
    expect(delivered?.proposal.state).toMatchObject({
      authorizationState: "refusal_alerted",
      alertedAt: NOW,
    });
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
        () => repository.requestRecheck({ ...identity("scoped"), now: NOW }),
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
