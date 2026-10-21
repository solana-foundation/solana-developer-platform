import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { RECURRING_PAYMENT_COLLECTION_CONFIG } from "@sdp/types/payments";
import type { Address, MaybeAccount, Signature } from "@solana/kit";
import {
  fetchMaybeSubscriptionAuthority,
  findSubscriptionAuthorityPda,
  getRevokeSubscriptionAuthorityOverlayInstructionAsync,
  type SubscriptionAuthority,
} from "@solana/subscriptions";
import { getDb } from "@/db/client";
import {
  createPostgresSubscriptionAuthorityRevocationsRepository,
  type RevocableSubscriptionAuthority,
  type SubscriptionAuthorityRevocationRow,
  type SubscriptionAuthorityRevocationsRepository,
} from "@/db/repositories/subscription-authority-revocations.repository";
import { badRequest, conflict } from "@/lib/errors";
import { resolveMintTokenProgram } from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { normalizePaymentToken } from "@/services/payment-operation.service";
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
  savedStepSend,
  sendSubscriptionInstructions,
} from "./shared";

/**
 * Revoking a wallet's per-mint Subscriptions authority once its recurring payments have ended
 * (HOO-2210).
 *
 * Activation approves the authority PDA as the SPL delegate on the wallet's token account for
 * u64::MAX. Cancel leaves it, because a canceled subscription stays resumable until the end of its
 * billing period and resume needs the same authority. Once every recurring payment on an authority
 * has ended and that period is over, this revokes the delegate and closes the PDA, refunding its
 * rent to whoever paid it.
 *
 * The revoke is an exit (`recurring.revoke_authority`), signed with no money principal: no API key
 * or member is asked, so revoking the key that set a schedule up never stops its cleanup, and an
 * organization's status never refuses it (ADR 0002).
 */

const MOVEMENT = "recurring.revoke_authority";
const REVOKE_FAILED_MESSAGE = "Subscription authority revoke failed on-chain";
const BATCH_SIZE = RECURRING_PAYMENT_COLLECTION_CONFIG.batchSize;
/** How long a failed revoke waits before the sweep tries its authority again. */
const FAILED_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

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
 * @param env - Runtime environment for repository and signer construction.
 * @param now - Tick time anchoring the idle, stale and retry windows.
 * @returns Per-outcome counts for this environment's run.
 */
export async function revokeIdleSubscriptionAuthorities(
  env: Env,
  now: Date
): Promise<RevokeIdleSubscriptionAuthoritiesResult> {
  const result: RevokeIdleSubscriptionAuthoritiesResult = {
    revoked: 0,
    recovered: 0,
    failed: 0,
    skipped: 0,
  };
  const { environment } = currentClusterScope();
  const repo = createPostgresSubscriptionAuthorityRevocationsRepository(getDb(env));
  const nowIso = now.toISOString();
  // Built on first use: a run with nothing to revoke makes no RPC call, and a cluster this
  // deployment has no endpoint for fails only when it has work.
  let clusterRpc: SolanaRpc | null = null;
  const rpc = () => {
    clusterRpc ??= createClusterRpc();
    return clusterRpc;
  };

  const stale = await repo.claimStaleRevocations({
    environment,
    staleBefore: new Date(
      now.getTime() - RECURRING_PAYMENT_COLLECTION_CONFIG.staleAfterMs
    ).toISOString(),
    now: nowIso,
    limit: BATCH_SIZE,
  });
  for (const revocation of stale) {
    const outcome = await isolated(revocation.subscription_authority_address, () =>
      settleRevocation(env, rpc(), repo, revocation, { resumed: true })
    );
    if (outcome === "revoked") result.recovered += 1;
    else if (outcome === "failed") result.failed += 1;
  }

  const retryFailedBefore = new Date(now.getTime() - FAILED_RETRY_AFTER_MS).toISOString();
  const candidates = await repo.listRevocableAuthorities({
    environment,
    idleBefore: nowIso,
    retryFailedBefore,
    limit: BATCH_SIZE,
  });
  for (const candidate of candidates) {
    const outcome = await isolated(candidate.subscription_authority_address, async () => {
      const claimed = await claimCandidate(env, environment, candidate, {
        idleBefore: nowIso,
        retryFailedBefore,
      });
      return claimed
        ? settleRevocation(env, rpc(), repo, claimed, { resumed: false })
        : ("skipped" as const);
    });
    if (outcome === "revoked") result.revoked += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "skipped") result.skipped += 1;
  }

  return result;
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
  environment: SdpEnvironment,
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
      organizationId: candidate.organization_id,
      projectId: candidate.project_id,
      environment,
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
 * when the send is refused or fails on chain, or left `processing` for a later run while the
 * outcome is unknown.
 */
async function settleRevocation(
  env: Env,
  rpc: SolanaRpc,
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
  // Set once a send is saved, before its broadcast: from then on it may land.
  let saved: Signature | null = null;
  try {
    const authorityAddress = assertValidAddress(
      revocation.subscription_authority_address,
      "subscriptionAuthority"
    );
    const authority = await fetchMaybeSubscriptionAuthority(rpc, authorityAddress, {
      commitment: options.resumed ? "finalized" : "confirmed",
    });
    if (!authority.exists) {
      return finish(repo, revocation, "confirmed", null);
    }

    const earlierSend = savedStepSend(revocation.signature, revocation.last_valid_block_height);
    if (earlierSend) {
      const outcome = await readSavedSend(rpc, earlierSend);
      // It landed but the authority is not gone at `finalized` yet, or it may still land.
      if (outcome === "succeeded" || outcome === "pending") return "pending";
      await repo.clearSend({
        id: revocation.id,
        signature: earlierSend.signature,
        updatedAt: new Date().toISOString(),
      });
    }

    const signature = await sendRevoke(env, rpc, repo, revocation, authority, (sent) => {
      saved = sent;
    });
    await confirmSubscriptionSignature(signature, REVOKE_FAILED_MESSAGE);
    return finish(repo, revocation, "confirmed", null);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Nothing was broadcast, or what was can never land: refused at preflight (the store cleared
    // its saved send) or failed on chain.
    if (saved === null || isDefiniteSubmissionError(error)) {
      getLogger().error({ ...logContext, err: error }, "Subscription authority revoke failed");
      return finish(repo, revocation, "failed", recurringPaymentErrorMessage(error));
    }
    // Sent, and it may have landed: a later run reads the chain and settles it.
    getLogger().warn(
      { ...logContext, err: error, signature: saved },
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
  await repo.finish({ id: revocation.id, status, error, updatedAt: new Date().toISOString() });
  return status === "confirmed" ? "revoked" : "failed";
}

async function sendRevoke(
  env: Env,
  rpc: SolanaRpc,
  repo: SubscriptionAuthorityRevocationsRepository,
  revocation: SubscriptionAuthorityRevocationRow,
  authority: MaybeAccount<SubscriptionAuthority> & { exists: true },
  onSaved: (signature: Signature) => void
): Promise<Signature> {
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
    tokenProgram: await resolveMintTokenProgram(rpc, tokenMint),
    // The program refunds the PDA's rent to the payer it recorded, and requires it named.
    ...(authority.data.payer === (wallet.publicKey as Address)
      ? {}
      : { receiver: authority.data.payer }),
  });

  return sendSubscriptionInstructions({
    movement: MOVEMENT,
    env,
    organizationId: revocation.organization_id,
    projectId: revocation.project_id,
    sourceWallet: wallet,
    sourceSigner: user,
    instructions: [instruction],
    submissionStore: revocationSubmissionStore(repo, revocation.id, onSaved),
  });
}

/** Saves the revoke's send before it is broadcast, and clears it after a provably refused send. */
function revocationSubmissionStore(
  repo: SubscriptionAuthorityRevocationsRepository,
  id: string,
  onSaved: (signature: Signature) => void
): SignedSubmissionStore {
  return {
    persistSigned: async ({ signature, lastValidBlockHeight }) => {
      const saved = await repo.saveSend({
        id,
        signature,
        lastValidBlockHeight,
        updatedAt: new Date().toISOString(),
      });
      if (!saved) throw conflict("Subscription authority revoke changed concurrently");
      onSaved(signature);
    },
    markStarted: async () => {},
    hasStarted: async () => false,
    clearSigned: async (signature) => {
      await repo.clearSend({ id, signature, updatedAt: new Date().toISOString() });
    },
  };
}
