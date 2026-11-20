import type { ProposalObservation } from "@sdp/custody/proposals";
import {
  isCancellableCustodyProposalPhase,
  isTerminalCustodyProposalPhase,
} from "@sdp/types/custody-proposals";
import type {
  CustodyProposalsRepository,
  SigningProposalRow,
} from "@/db/repositories/custody-proposals.repository";
import { conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { describeError } from "@/runtime/money-path-events";
import {
  type SigningProposalAdapter,
  signingProposalAdapter,
} from "@/services/custody/signing-proposal-adapter";
import type { Env } from "@/types/env";

type SigningProposalStore = Pick<
  CustodyProposalsRepository,
  | "transitionSigning"
  | "observeSigning"
  | "requireSigning"
  | "requestSigningCancellation"
  | "claimSigningPoll"
>;

function identity(row: SigningProposalRow) {
  return { organizationId: row.organization_id, projectId: row.project_id, proposalId: row.id };
}

async function observe(
  repo: SigningProposalStore,
  row: SigningProposalRow,
  adapter: SigningProposalAdapter
): Promise<ProposalObservation | null> {
  const observation = await adapter.read(row.id);
  if (observation === null) {
    // Repeated authenticated absence, not the age of a timed-out request, proves nonacceptance.
    await repo.transitionSigning({
      ...identity(row),
      event: { type: "observed_absent", at: new Date().toISOString() },
    });
    return null;
  }
  await repo.observeSigning({ ...identity(row), event: observation });
  return observation;
}

/** Read status only: recovered signatures never resume a dead request or broadcast. */
export function readSigningProposal(
  env: Env,
  repo: SigningProposalStore,
  row: SigningProposalRow
): Promise<ProposalObservation | null> {
  return observe(repo, row, signingProposalAdapter(env, row));
}

async function cancelObserved(
  repo: SigningProposalStore,
  row: SigningProposalRow,
  adapter: SigningProposalAdapter,
  observation: ProposalObservation
): Promise<{ acknowledged: boolean; row: SigningProposalRow }> {
  const key = identity(row);
  if (!isCancellableCustodyProposalPhase(observation.phase)) {
    return { acknowledged: false, row: await repo.requireSigning(key) };
  }
  // The shared reducer owns cooldowns and attempt identity, before the provider mutation.
  const claimed = await repo.transitionSigning({
    ...key,
    event: { type: "cancel_requested", at: new Date().toISOString() },
  });
  if (claimed === null) return { acknowledged: false, row: await repo.requireSigning(key) };
  let acknowledged = false;
  let outcome: "cancel_accepted" | "cancel_declined" | "cancel_ambiguous";
  try {
    acknowledged = await adapter.cancel(observation.providerTransactionId);
    outcome = acknowledged ? "cancel_accepted" : "cancel_declined";
  } catch (error) {
    outcome = "cancel_ambiguous";
    getLogger().warn(
      { proposalId: row.id, ...describeError(error) },
      "proposal_cancellation_unknown"
    );
  }
  await repo.transitionSigning({
    ...key,
    expectedCancelAttempt: claimed.state.cancelAttempt,
    event: { type: outcome, at: new Date().toISOString() },
  });
  try {
    await observe(repo, claimed, adapter);
  } catch (error) {
    getLogger().warn(
      { proposalId: row.id, ...describeError(error) },
      "proposal_status_unavailable"
    );
  }
  return { acknowledged, row: await repo.requireSigning(key) };
}

/** Persist manual cancellation before resolving credentials or mutating the provider. */
export async function cancelSigningProposal(
  env: Env,
  repo: SigningProposalStore,
  row: SigningProposalRow
): Promise<{ acknowledged: boolean; row: SigningProposalRow }> {
  const key = identity(row);
  if (!(await repo.requestSigningCancellation(key))) {
    return { acknowledged: false, row: await repo.requireSigning(key) };
  }
  const adapter = signingProposalAdapter(env, row);
  const observation = await observe(repo, row, adapter);
  if (observation === null) throw conflict("Proposal is unavailable; cancellation is unconfirmed");
  return cancelObserved(repo, row, adapter, observation);
}

/** Viewer throttling never consumes or clears a worker's recovery schedule. */
export async function pollSigningProposal(
  env: Env,
  repo: SigningProposalStore,
  row: SigningProposalRow
): Promise<{ row: SigningProposalRow; polled: boolean }> {
  const key = identity(row);
  if (
    isTerminalCustodyProposalPhase(row.state.providerPhase) ||
    !(await repo.claimSigningPoll(key))
  ) {
    return { row: await repo.requireSigning(key), polled: false };
  }
  await readSigningProposal(env, repo, row);
  return { row: await repo.requireSigning(key), polled: true };
}

/** Worker recovery only observes or retries durable cancellation; it cannot create work. */
export async function recoverSigningProposal(
  env: Env,
  repo: SigningProposalStore,
  row: SigningProposalRow
): Promise<{ row: SigningProposalRow; polled: boolean }> {
  const adapter = signingProposalAdapter(env, row);
  const observation = await observe(repo, row, adapter);
  const current = await repo.requireSigning(identity(row));
  if (observation !== null && current.state.refusal !== null) {
    const result = await cancelObserved(repo, current, adapter, observation);
    return { row: result.row, polled: true };
  }
  return { row: current, polled: true };
}
