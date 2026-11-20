import type { ProposalObservation } from "@sdp/custody/proposals";
import { createCustodyProposalState } from "@sdp/types/custody-proposals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SigningProposalRow } from "@/db/repositories/custody-proposals.repository";
import { env } from "@/test/helpers/env";
import * as adapters from "./signing-proposal-adapter";
import {
  cancelSigningProposal,
  pollSigningProposal,
  recoverSigningProposal,
} from "./signing-proposal-reconciliation";

vi.mock("./signing-proposal-adapter", () => ({ signingProposalAdapter: vi.fn() }));

const at = "2026-11-20T00:00:00.000Z";
const pending: ProposalObservation = {
  type: "observed",
  at,
  phase: "pending",
  providerTransactionId: "provider-1",
  providerStatus: "PENDING_AUTHORIZATION",
  providerSubStatus: null,
};

function proposal(refused = false): SigningProposalRow {
  return {
    id: "proposal-1",
    organization_id: "org-1",
    project_id: "prj-1",
    custody_wallet_id: "wallet-1",
    kind: "signing",
    payment_transfer_id: null,
    provider: "fireblocks",
    operation: "PROGRAM_CALL",
    binding: {},
    version: 1,
    request_id: null,
    finished_at: null,
    recheck_requested_at: null,
    next_check_at: at,
    last_checked_at: null,
    last_polled_at: null,
    created_at: at,
    updated_at: at,
    state: {
      ...createCustodyProposalState(),
      providerPhase: "pending",
      providerTransactionId: "provider-1",
      providerStatus: pending.providerStatus,
      authorizationState: refused ? "refused" : "authorized",
      refusal: refused ? { at, reason: "cancelled", message: "Cancelled" } : null,
    },
  };
}

function setup(row = proposal()) {
  const adapter: adapters.SigningProposalAdapter = {
    read: vi.fn().mockResolvedValue(pending),
    cancel: vi.fn().mockResolvedValue(true),
  };
  vi.mocked(adapters.signingProposalAdapter).mockReturnValue(adapter);
  const claimed = { ...row, state: { ...row.state, cancelAttempt: 1, cancelRequestedAt: at } };
  const repo: Parameters<typeof recoverSigningProposal>[1] = {
    observeSigning: vi.fn().mockResolvedValue(true),
    transitionSigning: vi.fn().mockResolvedValue(claimed),
    requireSigning: vi.fn().mockResolvedValue(row),
    requestSigningCancellation: vi.fn().mockResolvedValue(true),
    claimSigningPoll: vi.fn().mockResolvedValue(true),
  };
  return { row, repo, adapter };
}

beforeEach(() => vi.clearAllMocks());

describe("canonical signing proposal recovery", () => {
  it("keeps viewer observations read-only while cancellation remains pending", async () => {
    const { row, repo, adapter } = setup(proposal(true));
    await expect(pollSigningProposal(env, repo, row)).resolves.toEqual({ row, polled: true });
    expect(adapter.read).toHaveBeenCalledExactlyOnceWith(row.id);
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(repo.transitionSigning).not.toHaveBeenCalled();
  });

  it("persists cancellation before provider mutation and binds its result to that attempt", async () => {
    const { row, repo, adapter } = setup(proposal(true));
    await recoverSigningProposal(env, repo, row);
    expect(repo.transitionSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        proposalId: row.id,
        event: { type: "cancel_requested", at: expect.any(String) },
      })
    );
    expect(vi.mocked(repo.transitionSigning).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.cancel).mock.invocationCallOrder[0]
    );
    expect(adapter.cancel).toHaveBeenCalledExactlyOnceWith("provider-1");
    expect(repo.transitionSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedCancelAttempt: 1,
        event: { type: "cancel_accepted", at: expect.any(String) },
      })
    );
    expect(adapter.read).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a cancellation while the shared reducer's retry cooldown holds", async () => {
    const { row, repo, adapter } = setup(proposal(true));
    vi.mocked(repo.transitionSigning).mockResolvedValue(null);
    await recoverSigningProposal(env, repo, row);
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(adapter.read).toHaveBeenCalledTimes(1);
  });

  it("retains ambiguous cancellation for a later worker instead of fabricating success", async () => {
    const { row, repo, adapter } = setup(proposal(true));
    vi.mocked(adapter.cancel).mockRejectedValue(new Error("provider timeout"));
    await recoverSigningProposal(env, repo, row);
    expect(repo.transitionSigning).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedCancelAttempt: 1,
        event: { type: "cancel_ambiguous", at: expect.any(String) },
      })
    );
  });

  it("records missing-provider evidence without resubmitting or failing on request age", async () => {
    const { row, repo, adapter } = setup();
    vi.mocked(adapter.read).mockResolvedValue(null);
    await recoverSigningProposal(env, repo, row);
    expect(repo.transitionSigning).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: { type: "observed_absent", at: expect.any(String) },
      })
    );
    expect(adapter.cancel).not.toHaveBeenCalled();
  });

  it("records manual cancellation before resolving the provider adapter", async () => {
    const { row, repo } = setup();
    await cancelSigningProposal(env, repo, row);
    expect(vi.mocked(repo.requestSigningCancellation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapters.signingProposalAdapter).mock.invocationCallOrder[0]
    );
  });
});
