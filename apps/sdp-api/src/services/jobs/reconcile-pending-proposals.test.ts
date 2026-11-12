import type { FireblocksTransferResult } from "@sdp/custody/provisioning/fireblocks-transfers";
import { runInClusterScope } from "@sdp/rpc/scope";
import {
  createCustodyProposalState,
  hasUnalertedCustodyProposalRefusal,
  isTerminalCustodyProposalPhase,
  transitionCustodyProposal,
} from "@sdp/types/custody-proposals";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseExecutor } from "@/db/client";
import { currentDatabaseIdentity, runWithSystemDatabaseIdentity } from "@/db/identity";
import type { CustodyProposalRow } from "@/db/repositories/custody-proposals.repository";
import { createPostgresCustodyProposalsRepository } from "@/db/repositories/custody-proposals.repository.postgres";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { AppError } from "@/lib/errors";
import { currentMoneyPrincipal, type MoneyPrincipal } from "@/lib/money-principal";
import { rootLogger } from "@/runtime/logger";
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
  const ledger: ProposalLedger = {
    repo,
    proposals,
    audited: async (work) => (await work(repo, proposals)).result,
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
    claim,
    alerts,
    transition,
    apply,
    recovery,
    factory,
    alert,
    warn,
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reconcilePendingProposals", () => {
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
      limit: 50,
    });
    expect(currentMoneyPrincipal()).toBeNull();
  });

  it("persists refusal and cancellation intent before provider I/O, keeping acknowledgment nonterminal", async () => {
    const h = harness();
    h.recovery.admit.mockRejectedValue(revoke());
    h.recovery.cancel.mockImplementation(async () => {
      expect(h.state().state).toMatchObject({
        authorizationState: "cancel_requested",
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

  it("keeps sticky refusal and backs off ambiguous cancellation retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const h = harness();
    h.recovery.admit.mockRejectedValueOnce(revoke()).mockResolvedValue(undefined);
    h.recovery.cancel.mockRejectedValueOnce(new Error("Ambiguous cancellation timeout"));
    await runRecovery();
    const first = h.state().state;
    expect(first.authorizationState).toBe("cancel_requested");
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
    expect(h.payment().status).toBe("processing");
  });

  it("observes declined cancellations each tick while throttling provider retries and audit pairs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const h = harness();
    h.recovery.admit.mockRejectedValueOnce(revoke());
    h.recovery.cancel.mockResolvedValue(false);
    await runRecovery();
    expect(h.state().state.authorizationState).toBe("refused");
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
    expect(h.state().state.authorizationState).toBe("refused");
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

  it("does not reuse a provider observation after a competing state change", async () => {
    const h = harness();
    h.recovery.read.mockImplementation(async () => {
      h.states.set("xfr_recovery", { ...h.state(), version: h.state().version + 1 });
      return observation();
    });
    await runRecovery();
    expect(h.recovery.admit).not.toHaveBeenCalled();
    expect(h.recovery.cancel).not.toHaveBeenCalled();
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
      authorizationState: "committed_after_refusal",
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

  it("never cancels on a temporary admission failure or provider read failure", async () => {
    const h = harness();
    h.recovery.admit.mockRejectedValue(new Error("Admission database unavailable"));
    await runRecovery();
    h.recovery.read.mockRejectedValue(new Error("Provider unavailable"));
    await runRecovery();
    expect(h.state().state.refusal).toBeNull();
    expect(h.recovery.cancel).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledTimes(2);
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
    h.alert.mockImplementationOnce(() => {
      throw new Error("Alert delivery failed");
    });
    await expect(runRecovery()).rejects.toThrow("Alert delivery failed");
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
    h.alert.mockImplementationOnce(() => {
      throw new Error("First alert unavailable");
    });
    await expect(runRecovery()).rejects.toThrow("First alert unavailable");
    expect(h.state().state.alertedAt).toBeNull();
    expect(h.state("xfr_second").state.alertedAt).toEqual(expect.any(String));
  });

  it("drains terminal alerts even when the active recovery queue fails", async () => {
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
    h.claim.mockRejectedValue(new Error("Active queue unavailable"));
    await expect(runRecovery()).rejects.toThrow("Active queue unavailable");
    expect(h.alert).toHaveBeenCalledOnce();
    expect(h.state().state.alertedAt).toEqual(expect.any(String));
  });

  it("passes the authority-reduction filter to the independent worker and alert queues", async () => {
    const h = harness([]);
    const scope = { organizationId: "org_recovery", projectId: "prj_recovery", principal };
    await runRecovery(scope);
    expect(h.claim).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, environment: "sandbox", limit: 50 })
    );
    expect(h.alerts).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, environment: "sandbox", limit: 50 })
    );
  });
});
