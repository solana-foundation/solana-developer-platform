import type { FireblocksTransferResult } from "@sdp/custody/provisioning/fireblocks-transfers";
import { runInClusterScope } from "@sdp/rpc/scope";
import {
  CUSTODY_PROPOSAL_ACCEPTED_ACTIVE_PHASES,
  createCustodyProposalState,
  hasUnalertedCustodyProposalRefusal,
  isTerminalCustodyProposalPhase,
  transitionCustodyProposal,
} from "@sdp/types/custody-proposals";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseExecutor } from "@/db/client";
import { currentDatabaseIdentity, runWithSystemDatabaseIdentity } from "@/db/identity";
import type {
  CustodyProposalRow,
  SigningProposalRow,
} from "@/db/repositories/custody-proposals.repository";
import { createPostgresCustodyProposalsRepository } from "@/db/repositories/custody-proposals.repository.postgres";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { AppError } from "@/lib/errors";
import { currentMoneyPrincipal, type MoneyPrincipal } from "@/lib/money-principal";
import { rootLogger } from "@/runtime/logger";
import type { AuditLogEntry } from "@/services/audit.service";
import * as signingRecovery from "@/services/custody/signing-proposal-reconciliation";
import {
  type CustodyProposalRecovery,
  ProposalAdmissionRefusedError,
} from "@/services/domain/signing/admitted-proposer";
import * as ledgerFactory from "@/services/jobs/proposal-recovery-ledger";
import type { ProposalLedger } from "@/services/payments/custody-proposal-ledger";
import * as signer from "@/services/solana/signer";
import type { Env } from "@/types/env";
import { reconcilePendingProposals } from "./reconcile-pending-proposals";

const env: Env = { ENVIRONMENT: "development", API_VERSION: "v1" };
const principal: MoneyPrincipal = { kind: "api_key", apiKeyId: "key_original" };
const binding = {
  version: 1,
  provider: "fireblocks",
  connectionId: "cconn_original",
  accountFingerprint: "account_original",
  vaultAccountId: "0",
  assetId: "SOL_TEST",
};
const NOW = "2026-11-12T00:00:00.000Z";
function transfer(overrides: Partial<PaymentTransferRow> = {}): PaymentTransferRow {
  return {
    id: "xfr_recovery",
    organization_id: "org_recovery",
    project_id: "prj_recovery",
    custody_wallet_id: "cw_recovery",
    wallet_id: "fb_0",
    counterparty_id: null,
    source_address: "11111111111111111111111111111111",
    destination_address: "So11111111111111111111111111111111111111112",
    token: SOL_MINT,
    amount: "1",
    memo: null,
    type: "transfer",
    kind: "pay",
    direction: "outbound",
    status: "processing",
    provider: null,
    provider_reference: "fb_recovery",
    provider_observed_at: null,
    delivery_mode: null,
    fiat_currency: null,
    fiat_amount: null,
    ramps_memo: {},
    provider_data: { fireblocksTransfer: binding, fireblocksStatus: "PENDING_AUTHORIZATION" },
    signature: null,
    serialized_tx: null,
    signed_transaction: null,
    last_valid_block_height: null,
    submission_started_at: null,
    slot: null,
    block_time: null,
    fee: null,
    error: null,
    initiated_by_key_id: "audit_identity_is_not_authority",
    initiated_by_principal: principal,
    idempotency_key: null,
    idempotency_fingerprint: null,
    confirmed_at: null,
    finalization_last_polled_at: null,
    audit_intent_id: null,
    created_at: "2026-11-11T00:00:00.000Z",
    updated_at: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

function proposal(row: PaymentTransferRow): CustodyProposalRow {
  return {
    kind: "transfer",
    id: `proposal_${row.id}`,
    organization_id: row.organization_id,
    project_id: row.project_id,
    custody_wallet_id: row.custody_wallet_id,
    payment_transfer_id: row.id,
    provider: "fireblocks",
    binding,
    state: {
      ...createCustodyProposalState(),
      providerPhase: "pending",
      providerTransactionId: "fb_recovery",
      providerStatus: "PENDING_AUTHORIZATION",
      submissionStartedAt: NOW,
    },
    version: 1,
    recheck_requested_at: null,
    next_check_at: NOW,
    last_checked_at: null,
    last_polled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function observation(
  status = "PENDING_AUTHORIZATION",
  externalTxId = "xfr_recovery"
): FireblocksTransferResult {
  return {
    id: "fb_recovery",
    externalTxId,
    status,
    operation: "TRANSFER",
    assetId: "SOL_TEST",
    source: { type: "VAULT_ACCOUNT", id: "0" },
    subStatus: undefined,
    txHash: undefined,
    destinationAddress: undefined,
    amountInfo: undefined,
    feeCurrency: undefined,
    feeInfo: undefined,
  };
}

function harness(initialRows: PaymentTransferRow[] = [transfer()]) {
  const payments = new Map(initialRows.map((row) => [row.id, row]));
  const states = new Map(initialRows.map((row) => [row.id, proposal(row)]));
  const database: DatabaseExecutor = {
    prepare: () => {
      throw new Error("Unexpected database query");
    },
    queryOne: async () => {
      throw new Error("Unexpected database query");
    },
    queryMany: async () => {
      throw new Error("Unexpected database query");
    },
    execute: async () => {
      throw new Error("Unexpected database query");
    },
  };
  const repo = createPostgresPaymentsRepository(database);
  const proposals = createPostgresCustodyProposalsRepository(database);
  function payment(id = "xfr_recovery") {
    const row = payments.get(id);
    if (row === undefined) throw new Error(`Missing test payment ${id}`);
    return row;
  }
  function state(id = "xfr_recovery") {
    const row = states.get(id);
    if (row === undefined) throw new Error(`Missing test proposal ${id}`);
    return row;
  }
  vi.spyOn(repo, "getTransferById").mockImplementation(async (input) => payment(input.transferId));
  vi.spyOn(repo, "updateTransfer").mockImplementation(async (input) => {
    const row = payment(input.transferId);
    if (input.expectedStatus !== undefined && input.expectedStatus !== row.status) return null;
    const next = { ...row, provider_data: { ...row.provider_data, ...input.providerData } };
    if (input.status !== undefined) next.status = input.status;
    if (input.signature !== undefined) next.signature = input.signature;
    if (input.error !== undefined) next.error = input.error;
    payments.set(row.id, next);
    return next;
  });
  vi.spyOn(proposals, "getForTransfer").mockImplementation(async (input) =>
    state(input.transferId)
  );
  const adopt = vi.spyOn(proposals, "adoptLegacyTransfers").mockResolvedValue(0);
  vi.spyOn(proposals, "stats").mockImplementation(async () => {
    const pending = [...states.values()].filter(
      (row) => !isTerminalCustodyProposalPhase(row.state.providerPhase)
    );
    return {
      pending: pending.length,
      transfers: pending.length,
      signing: 0,
      oldestUnpolledAgeMs: 0,
    };
  });
  const recheck = vi.spyOn(proposals, "requestRecheck").mockImplementation(async (input) => {
    const current = state(input.transferId);
    states.set(input.transferId, {
      ...current,
      recheck_requested_at: current.recheck_requested_at ?? input.now,
    });
  });
  const claim = vi
    .spyOn(proposals, "claimDue")
    .mockImplementation(async () =>
      [...states.values()].filter((row) => !isTerminalCustodyProposalPhase(row.state.providerPhase))
    );
  const alerts = vi
    .spyOn(proposals, "listUnalerted")
    .mockImplementation(async () =>
      [...states.values()].filter((row) => hasUnalertedCustodyProposalRefusal(row.state))
    );
  function apply(input: Parameters<typeof proposals.transition>[0]) {
    const current = state(input.transferId);
    if (current.version !== input.expectedVersion) return null;
    const transition = transitionCustodyProposal(current.state, input.event);
    if ("rejected" in transition) return null;
    const next = { ...current, state: transition.next, version: current.version + 1 };
    states.set(current.payment_transfer_id, next);
    return { proposal: next, effects: transition.effects };
  }
  const transition = vi
    .spyOn(proposals, "transition")
    .mockImplementation(async (input) => apply(input));
  const entries: AuditLogEntry[] = [];
  const ledger: ProposalLedger = {
    repo,
    proposals,
    audited: async (work) => {
      const { entry, result } = await work(repo, proposals);
      if (entry !== null) entries.push(entry);
      return result;
    },
  };
  vi.spyOn(ledgerFactory, "systemProposalLedger").mockReturnValue(ledger);
  const recovery = {
    read: vi
      .fn<CustodyProposalRecovery["read"]>()
      .mockImplementation(async (id) => observation("PENDING_AUTHORIZATION", id)),
    admit: vi.fn<CustodyProposalRecovery["admit"]>().mockResolvedValue(undefined),
    cancel: vi.fn<CustodyProposalRecovery["cancel"]>().mockResolvedValue(true),
  } satisfies CustodyProposalRecovery;
  const factory = vi.spyOn(signer, "createOrgTransferProposalRecovery").mockResolvedValue(recovery);
  const alert = vi.spyOn(rootLogger, "fatal").mockImplementation(() => undefined);
  const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
  return {
    payments,
    states,
    payment,
    state,
    repo,
    proposals,
    adopt,
    recheck,
    claim,
    alerts,
    transition,
    apply,
    recovery,
    factory,
    alert,
    warn,
    entries,
  };
}

function runRecovery(scope?: Parameters<typeof reconcilePendingProposals>[1]) {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    runWithSystemDatabaseIdentity("cron:reconcile-custody-proposals", () =>
      reconcilePendingProposals(env, scope)
    )
  );
}
function revoke() {
  return new ProposalAdmissionRefusedError(
    "principal_not_live",
    new AppError("FORBIDDEN", "Original authority was revoked")
  );
}
function refuse(h: ReturnType<typeof harness>) {
  const row = h.state();
  h.states.set(row.payment_transfer_id, {
    ...row,
    state: {
      ...row.state,
      authorizationState: "refused",
      refusal: { at: NOW, reason: "principal_not_live", message: "Original authority was revoked" },
    },
  });
}

function observeDuringCancellation(
  h: ReturnType<typeof harness>,
  phase: (typeof CUSTODY_PROPOSAL_ACCEPTED_ACTIVE_PHASES)[number] = "pending"
) {
  const row = h.state();
  return h.apply({
    transferId: row.payment_transfer_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    expectedVersion: row.version,
    event: {
      type: "observed",
      at: new Date().toISOString(),
      phase,
      providerTransactionId: "fb_recovery",
      providerStatus: phase === "pending" ? "PENDING_AUTHORIZATION" : "BROADCASTING",
      providerSubStatus: null,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reconcilePendingProposals", () => {
  it("recovers transfers and general signing requests from the same claimed page", async () => {
    const h = harness();
    const signing: SigningProposalRow = {
      ...h.state(),
      id: "proposal_program_call",
      kind: "signing",
      payment_transfer_id: null,
      custody_wallet_id: "cw_recovery",
      operation: "PROGRAM_CALL",
      request_id: "request_original",
      finished_at: null,
    };
    h.claim.mockResolvedValue([signing, h.state()]);
    const recover = vi.spyOn(signingRecovery, "recoverSigningProposal").mockResolvedValue({
      row: signing,
      polled: true,
    });
    await runRecovery();
    expect(h.claim).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledExactlyOnceWith(env, h.proposals, signing);
    expect(h.recovery.read).toHaveBeenCalledExactlyOnceWith("xfr_recovery");
    expect(h.recovery.admit).toHaveBeenCalledOnce();
  });

  it("continues the mixed page before surfacing a signing provider failure", async () => {
    const h = harness();
    const signing: SigningProposalRow = {
      ...h.state(),
      id: "signing_unavailable",
      kind: "signing",
      payment_transfer_id: null,
      custody_wallet_id: "cw_recovery",
      operation: "PROGRAM_CALL",
      request_id: null,
      finished_at: null,
    };
    h.claim.mockResolvedValue([signing, h.state()]);
    const unavailable = new Error("Signing provider unavailable");
    vi.spyOn(signingRecovery, "recoverSigningProposal").mockRejectedValue(unavailable);
    await expect(runRecovery()).rejects.toBe(unavailable);
    expect(h.recovery.read).toHaveBeenCalledExactlyOnceWith("xfr_recovery");
    expect(h.recovery.admit).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "checks a concurrent signing alert acknowledgment (acknowledged=%s)",
    async (acknowledged) => {
      const h = harness([]);
      const signing: SigningProposalRow = {
        ...proposal(transfer()),
        id: "signing_alert",
        kind: "signing",
        payment_transfer_id: null,
        custody_wallet_id: "cw_recovery",
        operation: "PROGRAM_CALL",
        request_id: null,
        finished_at: NOW,
        state: {
          ...proposal(transfer()).state,
          providerPhase: "completed",
          authorizationState: "committed_after_refusal",
          refusal: { at: NOW, reason: "cancellation_requested", message: "Cancellation requested" },
        },
      };
      h.alerts.mockResolvedValue([signing]);
      vi.spyOn(h.proposals, "transitionSigning").mockResolvedValue(null);
      vi.spyOn(h.proposals, "requireSigning").mockResolvedValue(
        acknowledged
          ? {
              ...signing,
              state: { ...signing.state, authorizationState: "refusal_alerted", alertedAt: NOW },
            }
          : signing
      );
      if (acknowledged) await expect(runRecovery()).resolves.toBeUndefined();
      else
        await expect(runRecovery()).rejects.toMatchObject({
          name: "ProposalRefusalAlertDeliveryError",
        });
      expect(h.alert).toHaveBeenCalledOnce();
    }
  );

  it("drains a signing refusal alert without requiring a payment parent", async () => {
    const h = harness([]);
    const signing: SigningProposalRow = {
      ...proposal(transfer()),
      id: "proposal_program_call",
      kind: "signing",
      payment_transfer_id: null,
      custody_wallet_id: "cw_recovery",
      operation: "PROGRAM_CALL",
      request_id: "request_original",
      finished_at: NOW,
      state: {
        ...proposal(transfer()).state,
        providerPhase: "completed",
        authorizationState: "committed_after_refusal",
        refusal: { at: NOW, reason: "cancellation_requested", message: "Cancellation requested" },
      },
    };
    h.alerts.mockResolvedValue([signing]);
    const transition = vi.spyOn(h.proposals, "transitionSigning").mockResolvedValue({
      ...signing,
      state: { ...signing.state, authorizationState: "refusal_alerted", alertedAt: NOW },
    });
    await runRecovery();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "signing_proposal_completed_after_refusal",
        proposalId: signing.id,
      }),
      "signing_proposal_completed_after_refusal"
    );
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: signing.id,
        expectedVersion: signing.version,
        event: { type: "alert_delivered", at: expect.any(String) },
      })
    );
    expect(h.repo.getTransferById).not.toHaveBeenCalled();
    expect(h.recovery.read).not.toHaveBeenCalled();
  });

  it("rechecks live authority using only the recorded principal under the dedicated cron identity", async () => {
    const h = harness();
    h.recovery.admit.mockImplementation(async () => {
      await Promise.resolve();
      expect(currentMoneyPrincipal()).toEqual(principal);
      expect(currentDatabaseIdentity()).toEqual({
        kind: "system",
        component: "cron:reconcile-custody-proposals",
      });
    });
    await runRecovery();
    expect(h.recovery.admit).toHaveBeenCalledOnce();
    expect(h.recovery.cancel).not.toHaveBeenCalled();
    expect(h.adopt).toHaveBeenCalledWith({
      environment: "sandbox",
      now: expect.any(String),
      limit: 100,
    });
    expect(currentMoneyPrincipal()).toBeNull();
  });

  it("persists refusal and cancellation intent before provider I/O, keeping acknowledgment nonterminal", async () => {
    const h = harness();
    h.recovery.admit.mockRejectedValue(revoke());
    h.recovery.cancel.mockImplementation(async () => {
      expect(h.state().state).toMatchObject({
        authorizationState: "cancel_requested",
        cancelAttempt: 1,
        refusal: { reason: "principal_not_live" },
        cancelRequestedAt: expect.any(String),
      });
      return true;
    });
    await runRecovery();
    expect(h.state().state).toMatchObject({
      authorizationState: "cancel_acknowledged",
      providerPhase: "pending",
      cancelAcknowledgedAt: expect.any(String),
    });
    expect(h.payment().status).toBe("processing");
  });

  it.each([
    { accepted: true, phase: "pending" },
    { accepted: false, phase: "pending" },
    { accepted: true, phase: "executing" },
    { accepted: false, phase: "executing" },
  ] as const)(
    "persists cancellation accepted=$accepted when a $phase observation wins during provider I/O",
    async ({ accepted, phase }) => {
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      h.recovery.cancel.mockImplementation(async () => {
        expect(observeDuringCancellation(h, phase)).not.toBeNull();
        return accepted;
      });
      await runRecovery();
      expect(h.recovery.cancel).toHaveBeenCalledOnce();
      expect(h.state().state).toMatchObject({
        providerPhase: phase,
        authorizationState: accepted ? "cancel_acknowledged" : "cancel_declined",
      });
      expect(h.entries.map((entry) => entry.metadata?.eventType)).toEqual([
        "proposal_refused",
        "proposal_cancellation_requested",
        accepted ? "proposal_cancellation_accepted" : "proposal_cancellation_declined",
      ]);
      expect(h.payment().status).toBe("processing");
    }
  );

  it("retries lost result writes without repeating cancellation or its audit", async () => {
    const h = harness();
    h.recovery.admit.mockRejectedValue(revoke());
    let conflicts = 0;
    h.transition.mockImplementation(async (input) => {
      if (input.event.type === "cancel_accepted" && conflicts < 2) {
        conflicts += 1;
        observeDuringCancellation(h);
        return null;
      }
      return h.apply(input);
    });
    await runRecovery();
    expect(conflicts).toBe(2);
    expect(h.recovery.cancel).toHaveBeenCalledOnce();
    expect(h.state().state.authorizationState).toBe("cancel_acknowledged");
    const accepted = h.transition.mock.calls
      .map(([input]) => input.event)
      .filter((event) => event.type === "cancel_accepted");
    expect(accepted).toHaveLength(3);
    expect(new Set(accepted.map((event) => event.at)).size).toBe(1);
    expect(
      h.entries.filter((entry) => entry.metadata?.eventType === "proposal_cancellation_accepted")
    ).toHaveLength(1);
  });

  it.each([true, false])(
    "does not attach cancellation accepted=%s to a newer attempt",
    async (accepted) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      const newerAttemptAt = "2026-11-12T00:05:00.000Z";
      h.recovery.cancel.mockImplementation(async () => {
        const row = h.state();
        expect(
          h.apply({
            transferId: row.payment_transfer_id,
            organizationId: row.organization_id,
            projectId: row.project_id,
            expectedVersion: row.version,
            event: { type: "cancel_requested", at: newerAttemptAt },
          })
        ).not.toBeNull();
        return accepted;
      });
      await runRecovery();
      expect(h.state().state).toMatchObject({
        authorizationState: "cancel_requested",
        cancelAttempt: 2,
        cancelRequestedAt: newerAttemptAt,
        cancelAcknowledgedAt: null,
        cancelDeclinedAt: null,
      });
      expect(h.recovery.cancel).toHaveBeenCalledOnce();
      expect(h.entries).toHaveLength(2);
    }
  );

  it.each([true, false])(
    "preserves a terminal outcome over cancellation accepted=%s",
    async (accepted) => {
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      h.recovery.cancel.mockImplementation(async () => {
        const row = h.state();
        h.states.set(row.payment_transfer_id, {
          ...row,
          version: row.version + 1,
          state: { ...row.state, providerPhase: "cancelled" },
        });
        h.payments.set(row.payment_transfer_id, { ...h.payment(), status: "failed" });
        return accepted;
      });
      await runRecovery();
      expect(h.state().state).toMatchObject({
        providerPhase: "cancelled",
        cancelAcknowledgedAt: null,
        cancelDeclinedAt: null,
      });
      expect(h.payment().status).toBe("failed");
      expect(h.entries).toHaveLength(2);
    }
  );

  it.each([true, false, new Error("Ambiguous cancellation timeout")])(
    "keeps attempt identity independent of an identical request timestamp (result: %s)",
    async (result) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      h.recovery.cancel.mockImplementation(async () => {
        const row = h.state();
        h.states.set(row.payment_transfer_id, {
          ...row,
          version: row.version + 1,
          state: { ...row.state, cancelAttempt: row.state.cancelAttempt + 1 },
        });
        if (result instanceof Error) throw result;
        return result;
      });
      if (result instanceof Error) await expect(runRecovery()).rejects.toBe(result);
      else await runRecovery();
      expect(h.warn).toHaveBeenCalledTimes(result instanceof Error ? 1 : 0);
      expect(h.state().state).toMatchObject({
        authorizationState: "cancel_requested",
        cancelAttempt: 2,
        cancelRequestedAt: NOW,
        cancelAcknowledgedAt: null,
        cancelDeclinedAt: null,
      });
      expect(h.recovery.cancel).toHaveBeenCalledOnce();
      expect(h.entries.map((entry) => entry.metadata?.eventType)).toEqual([
        "proposal_refused",
        "proposal_cancellation_requested",
      ]);
    }
  );

  it.each(CUSTODY_PROPOSAL_ACCEPTED_ACTIVE_PHASES)(
    "persists ambiguous cancellation after a competing %s observation, preserving the error",
    async (phase) => {
      const h = harness();
      const unavailable = new Error("Ambiguous cancellation timeout");
      h.recovery.admit.mockRejectedValue(revoke());
      h.recovery.cancel.mockImplementation(async () => {
        expect(observeDuringCancellation(h, phase)).not.toBeNull();
        throw unavailable;
      });
      await expect(runRecovery()).rejects.toBe(unavailable);
      expect(h.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "proposal_recovery_unavailable",
          error_name: unavailable.name,
        }),
        "proposal_recovery_unavailable"
      );
      expect(h.recovery.cancel).toHaveBeenCalledOnce();
      expect(h.state().state).toMatchObject({
        providerPhase: phase,
        authorizationState: "cancel_ambiguous",
        cancelAttempt: 1,
        cancelAcknowledgedAt: null,
        cancelDeclinedAt: null,
      });
      expect(h.entries.map((entry) => entry.metadata?.eventType)).toEqual([
        "proposal_refused",
        "proposal_cancellation_requested",
      ]);
    }
  );

  it.each([true, false])(
    "records cancellation accepted=%s after a same-attempt ambiguous writer",
    async (accepted) => {
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      h.recovery.cancel.mockImplementation(async () => {
        const row = h.state();
        expect(
          h.apply({
            transferId: row.payment_transfer_id,
            organizationId: row.organization_id,
            projectId: row.project_id,
            expectedVersion: row.version,
            event: { type: "cancel_ambiguous", at: NOW },
          })
        ).not.toBeNull();
        return accepted;
      });
      await runRecovery();
      expect(h.state().state).toMatchObject({
        authorizationState: accepted ? "cancel_acknowledged" : "cancel_declined",
        cancelAttempt: 1,
      });
      expect(h.recovery.cancel).toHaveBeenCalledOnce();
      expect(h.entries.map((entry) => entry.metadata?.eventType)).toEqual([
        "proposal_refused",
        "proposal_cancellation_requested",
        accepted ? "proposal_cancellation_accepted" : "proposal_cancellation_declined",
      ]);
    }
  );

  it("signals a combined provider and persistence failure without repeating cancellation", async () => {
    const h = harness();
    const unavailable = new Error("Ambiguous cancellation timeout");
    const persistenceError = new Error("Cancellation state database unavailable");
    h.recovery.admit.mockRejectedValue(revoke());
    h.recovery.cancel.mockRejectedValue(unavailable);
    h.transition.mockImplementation(async (input) => {
      if (input.event.type === "cancel_ambiguous") throw persistenceError;
      return h.apply(input);
    });
    await expect(runRecovery()).rejects.toMatchObject({ errors: [unavailable, persistenceError] });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "proposal_recovery_unavailable",
        error_name: "AggregateError",
      }),
      "proposal_recovery_unavailable"
    );
    expect(h.recovery.cancel).toHaveBeenCalledOnce();
    expect(h.state().state.authorizationState).toBe("cancel_requested");
    expect(h.entries).toHaveLength(2);
  });

  it.each([true, false])(
    "preserves an already recorded cancellation accepted=%s",
    async (accepted) => {
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      h.recovery.cancel.mockImplementation(async () => {
        const row = h.state();
        expect(
          h.apply({
            transferId: row.payment_transfer_id,
            organizationId: row.organization_id,
            projectId: row.project_id,
            expectedVersion: row.version,
            event: { type: accepted ? "cancel_accepted" : "cancel_declined", at: NOW },
          })
        ).not.toBeNull();
        return !accepted;
      });
      await runRecovery();
      expect(h.state().state.authorizationState).toBe(
        accepted ? "cancel_acknowledged" : "cancel_declined"
      );
      expect(h.entries).toHaveLength(2);
      expect(h.recovery.cancel).toHaveBeenCalledOnce();
    }
  );

  it.each([true, false])(
    "bounds result writes when terminalOnLastConflict=%s",
    async (terminalOnLastConflict) => {
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      let conflicts = 0;
      h.transition.mockImplementation(async (input) => {
        if (input.event.type !== "cancel_accepted") return h.apply(input);
        conflicts += 1;
        observeDuringCancellation(h);
        if (terminalOnLastConflict && conflicts === 5) {
          const row = h.state();
          h.states.set(row.payment_transfer_id, {
            ...row,
            version: row.version + 1,
            state: { ...row.state, providerPhase: "cancelled" },
          });
        }
        return null;
      });
      if (terminalOnLastConflict) await runRecovery();
      else
        await expect(runRecovery()).rejects.toThrow(
          "Custody proposal cancellation result changed concurrently"
        );
      expect(h.warn).toHaveBeenCalledTimes(terminalOnLastConflict ? 0 : 1);
      expect(conflicts).toBe(5);
      expect(h.recovery.cancel).toHaveBeenCalledOnce();
      expect(h.state().state.cancelAcknowledgedAt).toBeNull();
      expect(h.entries).toHaveLength(2);
    }
  );

  it("keeps sticky refusal and backs off ambiguous cancellation retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const h = harness();
    h.recovery.admit.mockRejectedValueOnce(revoke()).mockResolvedValue(undefined);
    h.recovery.cancel.mockRejectedValueOnce(new Error("Ambiguous cancellation timeout"));
    await expect(runRecovery()).rejects.toThrow("Ambiguous cancellation timeout");
    expect(h.warn).toHaveBeenCalledOnce();
    const first = h.state().state;
    expect(first.authorizationState).toBe("cancel_ambiguous");
    expect(first.cancelAttempt).toBe(1);
    vi.setSystemTime("2026-11-12T00:01:00.000Z");
    await runRecovery();
    expect(h.recovery.cancel).toHaveBeenCalledOnce();
    expect(h.state().state.cancelRequestedAt).toBe(first.cancelRequestedAt);
    vi.setSystemTime("2026-11-12T00:05:00.000Z");
    await runRecovery();
    expect(h.recovery.admit).toHaveBeenCalledOnce();
    expect(h.recovery.cancel).toHaveBeenCalledTimes(2);
    expect(h.recovery.read).toHaveBeenCalledTimes(3);
    expect(h.state().state.refusal).toEqual(first.refusal);
    expect(h.state().state.cancelRequestedAt).toBe("2026-11-12T00:05:00.000Z");
    expect(h.state().state.cancelAttempt).toBe(2);
    expect(h.payment().status).toBe("processing");
  });

  it("observes declined cancellations each tick while throttling provider retries and audit pairs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const h = harness();
    h.recovery.admit.mockRejectedValueOnce(revoke());
    h.recovery.cancel.mockResolvedValue(false);
    await runRecovery();
    expect(h.state().state.authorizationState).toBe("cancel_declined");
    for (let minute = 1; minute < 5; minute += 1) {
      vi.setSystemTime(`2026-11-12T00:0${minute}:00.000Z`);
      await runRecovery();
    }
    expect(h.recovery.cancel).toHaveBeenCalledOnce();
    expect(h.recovery.read).toHaveBeenCalledTimes(5);
    expect(
      h.transition.mock.calls.filter(([input]) => input.event.type === "cancel_requested")
    ).toHaveLength(1);
    expect(
      h.transition.mock.calls.filter(([input]) => input.event.type === "cancel_declined")
    ).toHaveLength(1);
    vi.setSystemTime("2026-11-12T00:05:00.000Z");
    await runRecovery();
    expect(h.recovery.cancel).toHaveBeenCalledTimes(2);
    expect(h.recovery.admit).toHaveBeenCalledOnce();
    expect(h.state().state.authorizationState).toBe("cancel_declined");
    expect(h.payment().status).toBe("processing");
  });

  it("allows only the cancellation CAS winner to contact the provider", async () => {
    const h = harness();
    refuse(h);
    h.transition.mockImplementation(async (input) => {
      if (input.event.type !== "cancel_requested") return h.apply(input);
      const winner = h.apply(input);
      expect(winner).not.toBeNull();
      return null;
    });
    await runRecovery();
    expect(h.state().state.authorizationState).toBe("cancel_requested");
    expect(h.recovery.cancel).not.toHaveBeenCalled();
  });

  it.each(["observed", "admission_refused", "cancel_requested"] as const)(
    "restarts with a fresh provider read after losing the %s CAS to a status observation",
    async (eventType) => {
      const h = harness();
      h.recovery.admit.mockRejectedValue(revoke());
      let conflicted = false;
      h.transition.mockImplementation(async (input) => {
        if (!conflicted && input.event.type === eventType) {
          conflicted = true;
          observeDuringCancellation(h);
          return null;
        }
        return h.apply(input);
      });
      await runRecovery();
      expect(conflicted).toBe(true);
      expect(h.recovery.read).toHaveBeenCalledTimes(2);
      expect(h.recovery.cancel).toHaveBeenCalledExactlyOnceWith("xfr_recovery");
      expect(h.state().state.authorizationState).toBe("cancel_acknowledged");
      expect(h.recheck).not.toHaveBeenCalled();
    }
  );

  it("does not reuse the losing pending observation when a fresh read reports broadcasting", async () => {
    const h = harness();
    h.recovery.read.mockImplementationOnce(async () => {
      observeDuringCancellation(h, "executing");
      return observation();
    });
    h.recovery.read.mockResolvedValueOnce(observation("BROADCASTING"));
    await runRecovery();
    expect(h.recovery.read).toHaveBeenCalledTimes(2);
    expect(h.state().state.providerPhase).toBe("executing");
    expect(h.recovery.admit).not.toHaveBeenCalled();
    expect(h.recovery.cancel).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "stops at a terminal outcome on conflict %s and drains its refusal alert",
    async (terminalAt) => {
      const h = harness();
      let reads = 0;
      h.recovery.read.mockImplementation(async () => {
        reads += 1;
        if (reads < terminalAt) {
          observeDuringCancellation(h);
          return observation();
        }
        const row = h.state();
        h.states.set(row.payment_transfer_id, {
          ...row,
          version: row.version + 1,
          state: {
            ...row.state,
            providerPhase: "completed",
            authorizationState: "committed_after_refusal",
            refusal: { at: NOW, reason: "principal_not_live", message: "Authority revoked" },
          },
        });
        h.payments.set(row.payment_transfer_id, { ...h.payment(), status: "confirmed" });
        return observation();
      });
      await runRecovery();
      expect(h.recovery.read).toHaveBeenCalledTimes(terminalAt);
      expect(h.recovery.admit).not.toHaveBeenCalled();
      expect(h.recovery.cancel).not.toHaveBeenCalled();
      expect(h.alert).toHaveBeenCalledOnce();
      expect(h.state().state.authorizationState).toBe("refusal_alerted");
      expect(h.recheck).not.toHaveBeenCalled();
    }
  );

  it("bounds conflicting reads and restores priority without replacing an intervening wake", async () => {
    const h = harness();
    h.recovery.read.mockImplementation(async () => {
      observeDuringCancellation(h);
      const row = h.state();
      h.states.set(row.payment_transfer_id, { ...row, recheck_requested_at: NOW });
      return observation();
    });
    await expect(runRecovery()).rejects.toThrow("Custody proposal recovery changed concurrently");
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "proposal_recovery_unavailable",
        error_code: "INTERNAL_ERROR",
      }),
      "proposal_recovery_unavailable"
    );
    expect(h.recovery.read).toHaveBeenCalledTimes(2);
    expect(h.recovery.admit).not.toHaveBeenCalled();
    expect(h.recovery.cancel).not.toHaveBeenCalled();
    expect(h.recheck).toHaveBeenCalledExactlyOnceWith({
      transferId: "xfr_recovery",
      organizationId: "org_recovery",
      projectId: "prj_recovery",
      now: expect.any(String),
    });
    expect(h.state().recheck_requested_at).toBe(NOW);
  });

  it("records missing legacy authority without using its audit key as a principal", async () => {
    const h = harness([transfer({ initiated_by_principal: null })]);
    await runRecovery();
    expect(h.recovery.admit).not.toHaveBeenCalled();
    expect(h.state().state.refusal?.reason).toBe("principal_missing");
    expect(h.recovery.cancel).toHaveBeenCalledOnce();
  });

  it.each(["BROADCASTING", "CONFIRMING", "UNRECOGNIZED_PROVIDER_STATE"])(
    "only observes %s",
    async (status) => {
      const h = harness();
      h.recovery.read.mockResolvedValue(observation(status));
      await runRecovery();
      expect(h.state().state.providerPhase).toBe("executing");
      expect(h.recovery.admit).not.toHaveBeenCalled();
      expect(h.recovery.cancel).not.toHaveBeenCalled();
    }
  );

  it("does not re-admit or cancel when a known provider transaction is unavailable", async () => {
    const h = harness();
    h.recovery.read.mockResolvedValue(null);
    await runRecovery();
    expect(h.recovery.admit).not.toHaveBeenCalled();
    expect(h.recovery.cancel).not.toHaveBeenCalled();
  });

  it("reconciles an older writer's recorded completion after refusal without provider access", async () => {
    const h = harness();
    refuse(h);
    const payment = h.payment();
    h.payments.set(payment.id, {
      ...payment,
      status: "confirmed",
      signature:
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
      provider_data: { ...payment.provider_data, fireblocksStatus: "COMPLETED" },
    });
    h.factory.mockRejectedValue(new Error("Provider credential is revoked"));
    await runRecovery();
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.recovery.read).not.toHaveBeenCalled();
    expect(h.state().state).toMatchObject({
      providerPhase: "completed",
      authorizationState: "refusal_alerted",
      alertedAt: expect.any(String),
    });
    expect(h.alert).toHaveBeenCalledOnce();
  });

  it("delivers a newly observed completion-after-refusal before the worker returns", async () => {
    const h = harness();
    refuse(h);
    h.recovery.read.mockResolvedValue({
      ...observation("COMPLETED"),
      txHash:
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
      destinationAddress: h.payment().destination_address ?? undefined,
      amountInfo: { amount: "1", netAmount: "1", requestedAmount: "1" },
    });
    await runRecovery();
    expect(h.alert).toHaveBeenCalledOnce();
    expect(h.state().state.alertedAt).toEqual(expect.any(String));
    expect(h.recovery.cancel).not.toHaveBeenCalled();
  });

  it.each(["emission", "acknowledgment"])(
    "fails a mixed page when new completion-after-refusal alert %s fails outside the drain snapshot",
    async (failure) => {
      const h = harness([transfer(), transfer({ id: "xfr_second" })]);
      refuse(h);
      h.alerts.mockResolvedValue([]);
      h.warn.mockImplementation(() => {
        throw new Error("Ordinary recovery warnings are unavailable");
      });
      h.recovery.read.mockImplementation(async (id) =>
        id === "xfr_recovery"
          ? {
              ...observation("COMPLETED"),
              txHash:
                "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
              destinationAddress: h.payment().destination_address ?? undefined,
              amountInfo: { amount: "1", netAmount: "1", requestedAmount: "1" },
            }
          : observation("PENDING_AUTHORIZATION", id)
      );
      const unavailable = new Error("Alert delivery unavailable");
      if (failure === "emission") {
        h.alert.mockImplementationOnce(() => {
          throw unavailable;
        });
      } else {
        h.transition.mockImplementation(async (input) => {
          if (input.event.type === "alert_delivered") throw unavailable;
          return h.apply(input);
        });
      }
      await expect(runRecovery()).rejects.toMatchObject({
        name: "ProposalRefusalAlertDeliveryError",
        cause: unavailable,
      });
      expect(h.state().state).toMatchObject({
        providerPhase: "completed",
        authorizationState: "committed_after_refusal",
        alertedAt: null,
      });
      expect(h.state("xfr_second").state.authorizationState).toBe("authorized");
      expect(h.recovery.admit).toHaveBeenCalledOnce();
      expect(h.recovery.cancel).not.toHaveBeenCalled();
      expect(h.warn).not.toHaveBeenCalled();
    }
  );

  it("never cancels on a temporary admission failure or provider read failure", async () => {
    const h = harness();
    h.recovery.admit.mockRejectedValue(new Error("Admission database unavailable"));
    await expect(runRecovery()).rejects.toThrow("Admission database unavailable");
    h.recovery.read.mockRejectedValue(new Error("Provider unavailable"));
    await expect(runRecovery()).rejects.toThrow("Provider unavailable");
    expect(h.state().state.refusal).toBeNull();
    expect(h.recovery.cancel).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledTimes(2);
  });

  it("signals every aged row failure when the entire page is unavailable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-12T00:05:00.000Z");
    const h = harness([transfer(), transfer({ id: "xfr_second" })]);
    const firstError = new Error("First provider unavailable");
    const secondError = new Error("Second provider unavailable");
    h.recovery.read.mockImplementation(async (id) => {
      throw id === "xfr_recovery" ? firstError : secondError;
    });
    await expect(runRecovery()).rejects.toMatchObject({ errors: [firstError, secondError] });
    expect(h.recovery.read).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(2);
    for (const transferId of ["xfr_recovery", "xfr_second"]) {
      expect(h.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "proposal_recovery_unavailable",
          environment: "sandbox",
          transferId,
          pending_age_seconds: 300,
          error_name: "Error",
        }),
        "proposal_recovery_unavailable"
      );
    }
    expect(h.recovery.cancel).not.toHaveBeenCalled();
  });

  it("keeps the same aged failure signal when another row recovers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-12T00:05:00.000Z");
    const h = harness([transfer(), transfer({ id: "xfr_second" })]);
    h.recovery.read.mockRejectedValueOnce(new Error("First provider unavailable"));
    h.recovery.admit.mockRejectedValue(revoke());
    await expect(runRecovery()).rejects.toThrow("First provider unavailable");
    expect(h.state().state.refusal).toBeNull();
    expect(h.state("xfr_second").state.authorizationState).toBe("cancel_acknowledged");
    expect(h.recovery.cancel).toHaveBeenCalledExactlyOnceWith("xfr_second");
    expect(h.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "proposal_recovery_unavailable",
        environment: "sandbox",
        transferId: "xfr_recovery",
        pending_age_seconds: 300,
        error_name: "Error",
      }),
      "proposal_recovery_unavailable"
    );
  });

  it("drains terminal alerts even when every selected recovery fails", async () => {
    const h = harness([transfer(), transfer({ id: "xfr_alert" })]);
    const terminal = h.state("xfr_alert");
    h.states.set(terminal.payment_transfer_id, {
      ...terminal,
      state: {
        ...terminal.state,
        providerPhase: "completed",
        authorizationState: "committed_after_refusal",
        refusal: { at: NOW, reason: "principal_not_live", message: "Authority revoked" },
      },
    });
    h.recovery.read.mockRejectedValue(new Error("Provider unavailable"));
    await expect(runRecovery()).rejects.toThrow("Provider unavailable");
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.alert).toHaveBeenCalledOnce();
    expect(h.state("xfr_alert").state.alertedAt).toEqual(expect.any(String));
  });

  it("keeps terminal alerts durable across a failed emission", async () => {
    const h = harness();
    refuse(h);
    const row = h.state();
    h.states.set(row.payment_transfer_id, {
      ...row,
      state: {
        ...row.state,
        providerPhase: "completed",
        authorizationState: "committed_after_refusal",
      },
    });
    const unavailable = new Error("Alert delivery failed");
    h.alert.mockImplementationOnce(() => {
      throw unavailable;
    });
    await expect(runRecovery()).rejects.toMatchObject({
      name: "ProposalRefusalAlertDeliveryError",
      cause: unavailable,
    });
    expect(h.state().state.alertedAt).toBeNull();
    await runRecovery();
    expect(h.alert).toHaveBeenCalledTimes(2);
    expect(h.state().state.alertedAt).toEqual(expect.any(String));
    expect(h.recovery.read).not.toHaveBeenCalled();
  });

  it("does not let a failed first alert starve later completed proposals", async () => {
    const h = harness([transfer(), transfer({ id: "xfr_second" })]);
    for (const row of h.states.values()) {
      h.states.set(row.payment_transfer_id, {
        ...row,
        state: {
          ...row.state,
          providerPhase: "completed",
          authorizationState: "committed_after_refusal",
          refusal: { at: NOW, reason: "principal_not_live", message: "Authority revoked" },
        },
      });
    }
    const unavailable = new Error("First alert unavailable");
    h.alert.mockImplementationOnce(() => {
      throw unavailable;
    });
    await expect(runRecovery()).rejects.toMatchObject({
      name: "ProposalRefusalAlertDeliveryError",
      cause: unavailable,
    });
    expect(h.state().state.alertedAt).toBeNull();
    expect(h.state("xfr_second").state.alertedAt).toEqual(expect.any(String));
  });

  it("rechecks and cancels known proposals before reporting a failed legacy adoption", async () => {
    const h = harness();
    h.adopt.mockRejectedValue(new Error("Legacy adoption unavailable"));
    h.recovery.admit.mockRejectedValue(revoke());
    await expect(runRecovery()).rejects.toThrow("Legacy adoption unavailable");
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.recovery.read).toHaveBeenCalledOnce();
    expect(h.recovery.cancel).toHaveBeenCalledOnce();
    expect(h.state().state.authorizationState).toBe("cancel_acknowledged");
    expect(h.state().state.refusal?.reason).toBe("principal_not_live");
  });

  it("reports both legacy adoption and known-proposal queue failures", async () => {
    const h = harness();
    const adoptionError = new Error("Legacy adoption unavailable");
    const claimError = new Error("Active queue unavailable");
    h.adopt.mockRejectedValue(adoptionError);
    h.claim.mockRejectedValue(claimError);
    await expect(runRecovery()).rejects.toMatchObject({ errors: [adoptionError, claimError] });
  });

  it.each(["active queue", "legacy adoption"] as const)(
    "drains terminal alerts even when the %s fails",
    async (failure) => {
      const h = harness();
      refuse(h);
      const row = h.state();
      h.states.set(row.payment_transfer_id, {
        ...row,
        state: {
          ...row.state,
          providerPhase: "completed",
          authorizationState: "committed_after_refusal",
        },
      });
      const error = new Error("Recovery queue unavailable");
      if (failure === "active queue") h.claim.mockRejectedValue(error);
      else h.adopt.mockRejectedValue(error);
      await expect(runRecovery()).rejects.toThrow(error);
      expect(h.alert).toHaveBeenCalledOnce();
      expect(h.state().state.alertedAt).toEqual(expect.any(String));
    }
  );

  it("passes the authority-reduction filter to the independent worker and alert queues", async () => {
    const h = harness([]);
    const scope = { organizationId: "org_recovery", projectId: "prj_recovery", principal };
    await runRecovery(scope);
    expect(h.claim).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, environment: "sandbox", limit: 100 })
    );
    expect(h.alerts).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, environment: "sandbox", limit: 100 })
    );
  });
});
