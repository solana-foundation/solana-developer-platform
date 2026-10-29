import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { assertValidAddress } from "@sdp/solana/address";
import {
  isCanceledRecurringPaymentStatus,
  type PaymentRecurringPaymentStatus,
  RECURRING_PAYMENT_COLLECTION_CONFIG,
  type RecurringPaymentTokenApproval,
} from "@sdp/types/payments";
import type { Address, MaybeAccount, Signature } from "@solana/kit";
import {
  fetchMaybeSubscriptionAuthority,
  findSubscriptionAuthorityPda,
  getRevokeSubscriptionAuthorityOverlayInstructionAsync,
  type SubscriptionAuthority,
} from "@solana/subscriptions";
import { getDb } from "@/db/client";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import {
  createPostgresSubscriptionAuthorityRevocationsRepository,
  type RevocableSubscriptionAuthority,
  type SubscriptionAuthorityRevocationRow,
  type SubscriptionAuthorityRevocationsRepository,
} from "@/db/repositories/subscription-authority-revocations.repository";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { normalizePaymentToken } from "@/services/payment-operation.service";
import { loadPaymentMintFacts } from "@/services/payments/token-amount";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  isDefiniteSubmissionError,
  type SignedSubmissionStore,
} from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import {
  confirmSubscriptionSignature,
  readSavedSend,
  recurringPaymentErrorMessage,
  type SavedSendOutcome,
  type SavedStepSend,
  savedStepSend,
  sendSubscriptionInstructions,
} from "./shared";

/**
 * Revoking a wallet's per-mint Subscriptions authority once nothing needs it (HOO-2210, HOO-2339).
 *
 * Activation makes the authority PDA the SPL delegate on the wallet's token account; its allowance
 * is 0 between collections, each approving its own amount ({@link approveSubscriptionAuthority}).
 * A recurring payment's cancel is terminal, so the cancel revokes the authority itself
 * when it was the last use of it ({@link revokeSubscriptionAuthorityAfterCancel}). The sweep revokes
 * everything else once every subscription and recurring payment on an authority has ended (a
 * standalone subscription after its billing period, since its subscriber can still resume it), and
 * finishes any revoke a cancel left. A revoke closes the PDA, refunding its rent to whoever paid it.
 *
 * The revoke is an exit (`recurring.revoke_authority`); an organization's status never refuses it
 * (ADR 0002). The sweep signs it with no money principal, so no API key or member is asked and
 * revoking the key that set a schedule up never stops its cleanup. The inline revoke after a cancel
 * inherits the request's principal and is admitted as an exit through `decidePrincipal`: the
 * credential must still be live and hold the wallet in its scope, and a refusal leaves the revoke
 * `failed` for the sweep.
 */

const MOVEMENT = "recurring.revoke_authority";
const REVOKE_FAILED_MESSAGE = "Subscription authority revoke failed on-chain";
const BATCH_SIZE = RECURRING_PAYMENT_COLLECTION_CONFIG.batchSize;
/** How long a failed revoke waits before the sweep tries its authority again. */
const FAILED_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** Everything the sweep asks of the chain, each on the open cluster scope. */
export interface SubscriptionAuthorityChain {
  readAuthority(
    authority: Address,
    commitment: "confirmed" | "finalized"
  ): Promise<MaybeAccount<SubscriptionAuthority>>;
  readSavedSend(send: SavedStepSend): Promise<SavedSendOutcome>;
  /** Signs the revoke as the wallet and sends it sponsored, saving it to `store` before broadcast. */
  sendRevoke(input: {
    revocation: SubscriptionAuthorityRevocationRow;
    /** The rent payer the authority recorded, which the program requires named. */
    rentReceiver: Address;
    store: SignedSubmissionStore;
  }): Promise<Signature>;
  confirm(signature: Signature): Promise<void>;
}

/**
 * The chain as the cron uses it: the scope's cluster RPC, the custody signer and the sponsor.
 *
 * @param env - Runtime environment for signer and sponsor construction.
 * @returns The chain.
 */
function createClusterSubscriptionAuthorityChain(env: Env): SubscriptionAuthorityChain {
  return {
    readAuthority: (authority, commitment) =>
      fetchMaybeSubscriptionAuthority(createClusterRpc(), authority, { commitment }),
    readSavedSend: (send) => readSavedSend(createClusterRpc(), send),
    sendRevoke: (input) => sendRevoke(env, input),
    confirm: (signature) => confirmSubscriptionSignature(signature, REVOKE_FAILED_MESSAGE),
  };
}

export interface RevokeIdleSubscriptionAuthoritiesResult {
  revoked: number;
  recovered: number;
  failed: number;
  skipped: number;
}

type RevocationOutcome = "revoked" | "failed" | "pending";

/**
 * Revokes the open cluster scope's idle Subscriptions authorities, after settling any revoke an
 * earlier run left in flight.
 *
 * @param env - Runtime environment for repository construction.
 * @param now - Tick time anchoring the idle, stale and retry windows.
 * @param chain - The chain; the cluster's unless a test supplies one.
 * @returns Per-outcome counts for this environment's run.
 */
export async function revokeIdleSubscriptionAuthorities(
  env: Env,
  now: Date,
  chain: SubscriptionAuthorityChain = createClusterSubscriptionAuthorityChain(env)
): Promise<RevokeIdleSubscriptionAuthoritiesResult> {
  const result: RevokeIdleSubscriptionAuthoritiesResult = {
    revoked: 0,
    recovered: 0,
    failed: 0,
    skipped: 0,
  };
  const repo = createPostgresSubscriptionAuthorityRevocationsRepository(getDb(env));
  const nowIso = now.toISOString();

  const stale = await repo.claimStaleRevocations({
    environment: currentClusterScope().environment,
    staleBefore: new Date(
      now.getTime() - RECURRING_PAYMENT_COLLECTION_CONFIG.staleAfterMs
    ).toISOString(),
    now: nowIso,
    limit: BATCH_SIZE,
  });
  for (const revocation of stale) {
    const outcome = await isolated(revocation.subscription_authority_address, () =>
      settleRevocation(chain, repo, revocation, { resumed: true })
    );
    if (outcome === "revoked") result.recovered += 1;
    else if (outcome === "failed") result.failed += 1;
  }

  const retryFailedBefore = new Date(now.getTime() - FAILED_RETRY_AFTER_MS).toISOString();
  const candidates = await repo.listRevocableAuthorities({
    environment: currentClusterScope().environment,
    idleBefore: nowIso,
    retryFailedBefore,
    limit: BATCH_SIZE,
  });
  for (const candidate of candidates) {
    const outcome = await isolated(candidate.subscription_authority_address, async () => {
      const claimed = await claimCandidate(env, candidate, {
        idleBefore: nowIso,
        retryFailedBefore,
      });
      return claimed
        ? settleRevocation(chain, repo, claimed, { resumed: false })
        : ("skipped" as const);
    });
    if (outcome === "revoked") result.revoked += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "skipped") result.skipped += 1;
  }

  return result;
}

/**
 * Revokes the authority a recurring payment used, right after its cancel commits, when nothing else
 * needs it (HOO-2339). It claims the revoke exactly as the sweep does, under the wallet's lock and
 * the same idle predicate, so another live schedule on the authority, a revoke already holding it,
 * or a sweep run that claimed it first leaves it alone. A revoke it cannot finish stays on its row,
 * `processing` or `failed`, for the sweep; nothing here fails the cancel that already committed.
 *
 * @param env - Runtime environment for signer, sponsor and repository construction.
 * @param authority - The canceled payment's authority and the custody wallet that signs its revoke.
 * @returns Revoked, failed or pending (the sweep finishes it), or skipped (still needed, or held).
 */
export async function revokeSubscriptionAuthorityAfterCancel(
  env: Env,
  authority: RevocableSubscriptionAuthority
): Promise<RevocationOutcome | "skipped"> {
  const now = new Date();
  const windows = {
    idleBefore: now.toISOString(),
    retryFailedBefore: new Date(now.getTime() - FAILED_RETRY_AFTER_MS).toISOString(),
  };
  const repo = createPostgresSubscriptionAuthorityRevocationsRepository(getDb(env));
  return isolated(authority.subscription_authority_address, async () => {
    const claimed = await claimCandidate(env, authority, windows);
    return claimed
      ? settleRevocation(createClusterSubscriptionAuthorityChain(env), repo, claimed, {
          resumed: false,
        })
      : ("skipped" as const);
  });
}

/**
 * What became of the token approval a canceled recurring payment relied on (HOO-2339), from the
 * database alone: `revoked` once a revoke of its authority confirmed at or after the cancel,
 * `kept` while other recurring payments in any project still need the authority (`sharedWith`
 * names the ones in this recurring payment's own project), else `revoking`, which the hourly
 * sweep finishes. Two reads, no RPC.
 *
 * @param env - Runtime environment for repository construction.
 * @param recurringPayment - The recurring payment as read.
 * @returns The approval's state, or undefined unless the payment is canceled and recorded an
 *   authority.
 */
export async function describeTokenApprovalAfterCancel(
  env: Env,
  recurringPayment: PaymentRecurringPaymentRow
): Promise<RecurringPaymentTokenApproval | undefined> {
  const delegate = recurringPayment.subscription_authority_address;
  if (!isCanceledRecurringPaymentStatus(recurringPayment.status) || delegate === null) {
    return undefined;
  }
  const repo = createPostgresSubscriptionAuthorityRevocationsRepository(getDb(env));
  // A canceled row changes no more (migration 0190), so its updated_at is when the cancel landed.
  if (
    await repo.hasConfirmedRevocationSince({
      environment: currentClusterScope().environment,
      subscriptionAuthorityAddress: delegate,
      since: recurringPayment.updated_at,
    })
  ) {
    return { status: "revoked", delegate, sharedWith: [] };
  }
  const sharing = await repo.listRecurringPaymentsSharingAuthority({
    environment: currentClusterScope().environment,
    subscriptionAuthorityAddress: delegate,
    excludeRecurringPaymentId: recurringPayment.id,
  });
  // The caller can read this project's schedules; one in another project still keeps the
  // approval, but is not named.
  const sharedWith = sharing
    .filter(
      (payment) =>
        payment.organization_id === recurringPayment.organization_id &&
        payment.project_id === recurringPayment.project_id
    )
    .map(({ id, status }) => ({ id, status }));
  return { status: sharing.length > 0 ? "kept" : "revoking", delegate, sharedWith };
}

/** What an operator's incident revoke did, and the live schedules it leaves without an approval. */
export interface OperatorRevokeResult {
  outcome: RevocationOutcome | "held";
  subscriptionAuthorityAddress: Address;
  brokenRecurringPayments: {
    id: string;
    status: PaymentRecurringPaymentStatus;
    projectId: string;
  }[];
}

/**
 * Revokes a wallet's per-mint Subscriptions authority now, during an incident, whatever still uses
 * it (HOO-2339): unlike the sweep and the cancel's inline revoke it skips the idle predicate, so
 * every live schedule on that wallet and token stops being able to collect. Their collections then
 * fail on chain and pause them (HOO-2340); cancel them, or activate them again once the incident is
 * over. It signs the `recurring.revoke_authority` exit with no money principal, as the sweep does,
 * so neither an organization's status nor a disabled movement refuses it. Only a revoke already
 * holding the authority stops it (`held`): that one finishes it. Its RPC is the sweep's: one
 * authority read, the revoke's send and its confirmation.
 *
 * @param env - Runtime environment for signer, sponsor and repository construction.
 * @param input.organizationId - The wallet's organization.
 * @param input.projectId - The wallet's project.
 * @param input.custodyWalletId - The custody wallet that granted the approval.
 * @param input.token - The token mint, or a symbol SDP resolves.
 * @param input.incident - Who ran it, why, and the incident ticket, logged with the outcome.
 * @param chain - The chain; the cluster's unless a test supplies one.
 * @returns The revoke's outcome and the schedules it broke.
 * @throws AppError `NOT_FOUND` when the project or wallet is not live.
 */
export async function revokeSubscriptionAuthorityNow(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    custodyWalletId: string;
    token: string;
    incident: { operator: string; reason: string; ticket: string };
  },
  chain: SubscriptionAuthorityChain = createClusterSubscriptionAuthorityChain(env)
): Promise<OperatorRevokeResult> {
  const wallet = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOperationalWalletById({
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.custodyWalletId,
  });
  if (!wallet) throw notFound("Custody wallet");
  const walletAddress = assertValidAddress(wallet.publicKey, "walletAddress");
  const tokenMint = assertValidAddress(normalizePaymentToken(input.token), "token");
  const [subscriptionAuthorityAddress] = await findSubscriptionAuthorityPda({
    user: walletAddress,
    tokenMint,
  });
  const repo = createPostgresSubscriptionAuthorityRevocationsRepository(getDb(env));
  const claimed = await getDb(env).transaction(async (tx) => {
    const txRepo = createPostgresSubscriptionAuthorityRevocationsRepository(tx);
    await txRepo.lockWalletAuthorities(walletAddress);
    return txRepo.claimRevocationNow({
      id: `psar_${crypto.randomUUID()}`,
      leaseId: `lease_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: currentClusterScope().environment,
      custodyWalletId: wallet.id,
      walletAddress,
      tokenMint,
      subscriptionAuthorityAddress,
      now: new Date().toISOString(),
    });
  });
  const outcome = claimed
    ? await settleRevocation(chain, repo, claimed, { resumed: false })
    : ("held" as const);
  const brokenRecurringPayments = (
    await repo.listRecurringPaymentsSharingAuthority({
      environment: currentClusterScope().environment,
      subscriptionAuthorityAddress,
      excludeRecurringPaymentId: "",
    })
  ).map(({ id, status, project_id }) => ({ id, status, projectId: project_id }));
  logEvent(outcome === "revoked" ? "warn" : "error", {
    event: "sdp_subscription_authority_operator_revoke",
    outcome,
    operator: input.incident.operator,
    reason: input.incident.reason,
    ticket: input.incident.ticket,
    organization_id: input.organizationId,
    project_id: input.projectId,
    custody_wallet_id: wallet.id,
    subscription_authority_address: subscriptionAuthorityAddress,
    revocation_id: claimed?.id ?? null,
    broken_recurring_payment_ids: brokenRecurringPayments.map((payment) => payment.id),
  });
  return { outcome, subscriptionAuthorityAddress, brokenRecurringPayments };
}

/**
 * Runs one authority's work so that an error in it (a database or RPC read the settle path does
 * not catch) is logged and leaves the rest of the run going. A claimed revoke it interrupts stays
 * `processing` and is settled once stale.
 */
async function isolated<T>(
  subscriptionAuthorityAddress: string,
  work: () => Promise<T>
): Promise<T | "pending"> {
  try {
    return await work();
  } catch (error) {
    getLogger().error(
      { err: error, subscription_authority_address: subscriptionAuthorityAddress },
      "Subscription authority cleanup failed for one authority; continuing"
    );
    return "pending";
  }
}

/**
 * Claims a candidate under its wallet's lock, after checking it names the authority its wallet and
 * mint derive. Null when it no longer qualifies or does not match.
 */
async function claimCandidate(
  env: Env,
  candidate: RevocableSubscriptionAuthority,
  windows: { idleBefore: string; retryFailedBefore: string }
): Promise<SubscriptionAuthorityRevocationRow | null> {
  const tokenMint = assertValidAddress(normalizePaymentToken(candidate.token), "token");
  const wallet = assertValidAddress(candidate.wallet_address, "walletAddress");
  const [derived] = await findSubscriptionAuthorityPda({ user: wallet, tokenMint });
  if (derived !== candidate.subscription_authority_address) {
    getLogger().error(
      {
        organization_id: candidate.organization_id,
        project_id: candidate.project_id,
        subscription_authority_address: candidate.subscription_authority_address,
        reason: "subscription_authority_mismatch",
      },
      "Stored subscription authority does not match its wallet and mint"
    );
    return null;
  }

  return getDb(env).transaction(async (tx) => {
    const repo = createPostgresSubscriptionAuthorityRevocationsRepository(tx);
    await repo.lockWalletAuthorities(wallet);
    return repo.claimRevocation({
      id: `psar_${crypto.randomUUID()}`,
      leaseId: `lease_${crypto.randomUUID()}`,
      organizationId: candidate.organization_id,
      projectId: candidate.project_id,
      environment: currentClusterScope().environment,
      custodyWalletId: candidate.custody_wallet_id,
      walletAddress: wallet,
      tokenMint,
      subscriptionAuthorityAddress: derived,
      ...windows,
      now: new Date().toISOString(),
    });
  });
}

/**
 * Takes a claimed revoke to its end: confirmed once the authority is gone from the chain, failed
 * when nothing sent can still land, or left `processing` for a later run while a send's outcome is
 * unknown.
 */
async function settleRevocation(
  chain: SubscriptionAuthorityChain,
  repo: SubscriptionAuthorityRevocationsRepository,
  revocation: SubscriptionAuthorityRevocationRow,
  options: { resumed: boolean }
): Promise<RevocationOutcome> {
  const logContext = {
    organization_id: revocation.organization_id,
    project_id: revocation.project_id,
    revocation_id: revocation.id,
    subscription_authority_address: revocation.subscription_authority_address,
  };
  const earlierSend = savedStepSend(revocation.signature, revocation.last_valid_block_height);
  // A send that may still land: an earlier run's until the chain proves otherwise, then this
  // run's once its store saves it. While one is outstanding a failure keeps the hold.
  let outstanding: Signature | null = earlierSend?.signature ?? null;
  try {
    const authorityAddress = assertValidAddress(
      revocation.subscription_authority_address,
      "subscriptionAuthority"
    );
    const authority = await chain.readAuthority(
      authorityAddress,
      options.resumed ? "finalized" : "confirmed"
    );
    if (!authority.exists) {
      return finish(repo, revocation, "confirmed", null);
    }

    if (earlierSend) {
      const outcome = await chain.readSavedSend(earlierSend);
      // It landed but the authority is not gone at `finalized` yet, or it may still land.
      if (outcome === "succeeded" || outcome === "pending") return "pending";
      await repo.clearSend({
        id: revocation.id,
        leaseId: revocation.lease_id,
        signature: earlierSend.signature,
        updatedAt: new Date().toISOString(),
      });
      outstanding = null;
    }

    const signature = await chain.sendRevoke({
      revocation,
      rentReceiver: authority.data.payer,
      store: revocationSubmissionStore(repo, revocation, (saved) => {
        outstanding = saved;
      }),
    });
    await chain.confirm(signature);
    return finish(repo, revocation, "confirmed", null);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Nothing that may land is outstanding: no send was saved, or this run's was refused at
    // preflight (its store cleared it) or failed on chain.
    if (outstanding === null || isDefiniteSubmissionError(error)) {
      getLogger().error({ ...logContext, err: error }, "Subscription authority revoke failed");
      return finish(repo, revocation, "failed", recurringPaymentErrorMessage(error));
    }
    getLogger().warn(
      { ...logContext, err: error, signature: outstanding },
      "Subscription authority revoke left in flight"
    );
    return "pending";
  }
}

async function finish(
  repo: SubscriptionAuthorityRevocationsRepository,
  revocation: SubscriptionAuthorityRevocationRow,
  status: "confirmed" | "failed",
  error: string | null
): Promise<RevocationOutcome> {
  const finished = await repo.finish({
    id: revocation.id,
    leaseId: revocation.lease_id,
    status,
    error,
    updatedAt: new Date().toISOString(),
  });
  // Another run took the revoke over: it settles it.
  if (finished === null) return "pending";
  return status === "confirmed" ? "revoked" : "failed";
}

async function sendRevoke(
  env: Env,
  input: Parameters<SubscriptionAuthorityChain["sendRevoke"]>[0]
): Promise<Signature> {
  const { revocation } = input;
  const wallet = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOperationalWalletById({
    organizationId: revocation.organization_id,
    projectId: revocation.project_id,
    custodyWalletId: revocation.custody_wallet_id,
  });
  if (!wallet || wallet.publicKey !== revocation.wallet_address) {
    throw badRequest("The wallet that granted this subscription authority is not available");
  }
  const tokenMint = assertValidAddress(revocation.token_mint, "tokenMint");
  const user = await createOrgSignerForCustodyWallet(
    env,
    revocation.organization_id,
    revocation.project_id,
    wallet.id,
    MOVEMENT
  );
  const instruction = await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
    user,
    tokenMint,
    tokenProgram: (await loadPaymentMintFacts(tokenMint)).tokenProgram,
    // Valid whoever paid: the program requires the recorded payer when it is not the wallet.
    receiver: input.rentReceiver,
  });

  return sendSubscriptionInstructions({
    movement: MOVEMENT,
    env,
    organizationId: revocation.organization_id,
    projectId: revocation.project_id,
    sourceWallet: wallet,
    sourceSigner: user,
    instructions: [instruction],
    submissionStore: input.store,
  });
}

/**
 * Saves the revoke's send before it is broadcast, under the caller's lease, and clears it after a
 * provably refused send.
 */
function revocationSubmissionStore(
  repo: SubscriptionAuthorityRevocationsRepository,
  revocation: SubscriptionAuthorityRevocationRow,
  onSaved: (signature: Signature) => void
): SignedSubmissionStore {
  return {
    persistSigned: async ({ signature, lastValidBlockHeight }) => {
      const saved = await repo.saveSend({
        id: revocation.id,
        leaseId: revocation.lease_id,
        signature,
        lastValidBlockHeight,
        updatedAt: new Date().toISOString(),
      });
      // Taken over by another run: refuse before broadcasting anything.
      if (!saved) throw conflict("Subscription authority revoke was taken over by another run");
      onSaved(signature);
    },
    markStarted: async () => {},
    hasStarted: async () => false,
    clearSigned: async (signature) => {
      await repo.clearSend({
        id: revocation.id,
        leaseId: revocation.lease_id,
        signature,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
