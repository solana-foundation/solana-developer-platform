/**
 * SPC wallet-verification orchestration (the write path) + the default-identity read.
 *
 * Drives the SPC auth handshake for one SDP custody wallet:
 *   1. authorize/admit the exact custody wallet and prepare its signer
 *   2. resolve the connected instance + the selected project identity's SPC user
 *   3. open an SPC JWT handle (KV-cached via ./auth/gateway-auth)
 *   4. `challenge-wallet` → sign the challenge with THAT wallet → `verify-wallet`
 *   5. persist the verification (idempotent per (user, instance, pubkey))
 *
 * The persist step is conditional on the durable revocation epoch for
 * (instance, pubkey): a revocation advances it in the same transaction that
 * removes the mirror, so an in-flight verification whose upstream binding was
 * concurrently revoked cannot recreate `private_channel_verified_wallets`
 * after `deleteWallet` succeeded (SOLA9-664). When the epoch race is lost, the
 * upstream binding this request created is revoked again (idempotent) unless a
 * newer verification has already re-created the mirror or another rejected
 * verification's cleanup for the same binding is still pending (one binding
 * per SPC user and pubkey — its single compensating delete covers them all),
 * and the cleanup claim records a durable retry marker either way, so no
 * late binding survives a completed cleanup. The claim's marker carries an
 * ownership watermark: the compensating clear only removes the marker while
 * it still carries that watermark, so a fallback that re-owns the marker on
 * behalf of a newer rejected verification survives the older cleaner's
 * convergence. The retry marker also latches the
 * mirror upsert while a compensating delete is still owed — a verification it
 * refuses is told to retry and finishes the owed cleanup itself when the
 * claim is free or stale, so the compensating delete can never take a fresh
 * verification's binding — and whenever the request exits without completing
 * the compensating delete itself (the claim undecided, or a stand-down whose
 * bounded wait outlived the pending cleaner), the marker is still recorded
 * (without advancing the epoch) so the late binding stays recoverable.
 *
 * Signing is exact-wallet-specific via `createOrgSignerForCustodyWallet` (not
 * `SigningService.sign`, which signs with the scope-default wallet). The
 * resolved signer is a message-partial-signer at runtime; we sign the challenge
 * as raw bytes — matching SPC's `signature.verify(pubkey, message.as_bytes())` —
 * and take the verified pubkey straight from `signer.address`.
 *
 * This module is the single writer of `private_channel_verified_wallets`.
 */

import { PrivateChannelError } from "@sdp/private-channels";
import { createAuthClient, type SpcAuthClient } from "@sdp/private-channels/auth";
import { getBase58Codec } from "@solana/codecs";
import { createSignableMessage, isMessagePartialSigner } from "@solana/signers";
import {
  createPrivateChannelInstanceRepository,
  createPrivateChannelUserRepository,
  createPrivateChannelVerifiedWalletRepository,
  type PrivateChannelInstanceRow,
  type PrivateChannelUserRow,
  type PrivateChannelVerifiedWalletRow,
} from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, conflict, forbidden, notFound, providerNotConfigured } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { openSpcAuthContext, type SpcAuthContext, withSpcAuth } from "./auth/gateway-auth";
import { createPrivateChannelSigner, resolvePrivateChannelCustodyWallet } from "./wallet-access";

const base58 = getBase58Codec();

// Verify chains up to three sequential SPC calls (login → challenge → verify) in
// one API request; cap each below the client's 15s default so a degraded auth
// service can't stack into a ~45s request.
const SPC_AUTH_TIMEOUT_MS = 8_000;

function requireActiveInstance(instance: PrivateChannelInstanceRow | null): asserts instance {
  if (!instance) {
    throw providerNotConfigured(
      "No active Private Channels instance is connected for this project."
    );
  }
}

interface WalletSession {
  scope: { organizationId: string; projectId: string };
  instance: PrivateChannelInstanceRow;
  pcUser: PrivateChannelUserRow;
  client: SpcAuthClient;
  spcAuth: SpcAuthContext;
}

/**
 * Shared preamble for the verify/delete write paths: resolve the connected
 * instance and the requested project principal (default when omitted), then
 * open a cached SPC JWT handle.
 */
async function resolveWalletSession(
  env: Env,
  auth: ApiKeyContext,
  projectId: string,
  principalId?: string,
  allowDisabled = false
): Promise<WalletSession> {
  const scope = { organizationId: auth.organizationId, projectId };

  const instance = await createPrivateChannelInstanceRepository(env).getActiveByProject(scope);
  requireActiveInstance(instance);

  const principalRepo = createPrivateChannelUserRepository(env);
  const pcUser = principalId
    ? await principalRepo.getById(scope, principalId)
    : await principalRepo.findDefaultPrincipal(scope, instance.id);
  if (!pcUser) {
    if (principalId) {
      throw notFound("Active Private Channels principal");
    }
    throw forbidden("This project has no active Private Channels principal.");
  }
  if (pcUser.instance_id !== instance.id || (pcUser.disabled_at && !allowDisabled)) {
    throw notFound("Active Private Channels principal");
  }

  const client = createAuthClient(instance.auth_url, { timeoutMs: SPC_AUTH_TIMEOUT_MS });
  const spcAuth = await openSpcAuthContext(env, auth.organizationId, instance.id, pcUser, client);

  return { scope, instance, pcUser, client, spcAuth };
}

async function revokeWalletWithSession(
  env: Env,
  session: WalletSession,
  pubkey: string,
  claimedMarkerUpdatedAt?: string
): Promise<boolean> {
  const { scope, instance, pcUser, client, spcAuth } = session;
  // SPC returns 400 when the wallet is already unlinked. Treat that response as
  // convergence and still remove the local mirror; all other failures abort.
  await withSpcAuth(spcAuth, async (token) => {
    try {
      await client.deleteWallet(token, pubkey);
    } catch (error) {
      if (!(error instanceof PrivateChannelError) || error.code !== "BAD_REQUEST") {
        throw error;
      }
    }
  });

  // The local half is atomic: advancing the revocation epoch together with the
  // mirror removal is what makes an in-flight verification's conditional upsert
  // lose, so a completed revocation can never be undone by a stale mirror write.
  // The compensating cleanup scopes its marker clear to its claim's watermark
  // (see compensateRejectedVerification); a real delete covers the binding
  // outright and clears whatever marker is present.
  return createPrivateChannelVerifiedWalletRepository(env).revokeVerifiedWallet({
    ...scope,
    userId: pcUser.id,
    instanceId: instance.id,
    pubkey,
    ...(claimedMarkerUpdatedAt !== undefined && { claimedMarkerUpdatedAt }),
  });
}

/**
 * Best-effort status check after a rejected mirror write: whether a
 * pending-revocation marker for this pubkey still owes a compensating SPC
 * delete. Unreadable (transient persistence failure) means undetected.
 */
async function hasPendingRevocation(
  env: Env,
  principalId: string,
  instanceId: string,
  pubkey: string
): Promise<boolean> {
  try {
    return await createPrivateChannelVerifiedWalletRepository(env).hasPendingRevocation(
      principalId,
      instanceId,
      pubkey
    );
  } catch (statusError) {
    getLogger().warn(
      { principalId, instanceId, statusError },
      "private-channel wallet: could not check for a pending revocation after a rejected mirror"
    );
    return false;
  }
}

/**
 * Best-effort durable record of a still-owed upstream delete after the
 * cleanup claim itself failed, so the late binding stays recoverable by the
 * next principal-disable cleanup. Returns false when the record was skipped
 * because this identity's fresh mirror already owns the binding.
 */
async function recordPendingRevocation(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    userId: string;
    instanceId: string;
    walletId: string;
    pubkey: string;
  }
): Promise<boolean> {
  try {
    return await createPrivateChannelVerifiedWalletRepository(env).recordPendingRevocation(input);
  } catch (markerError) {
    getLogger().warn(
      { principalId: input.userId, instanceId: input.instanceId, markerError },
      "private-channel wallet: could not record a pending-revocation marker after a failed cleanup claim"
    );
    return false;
  }
}

// How long a stand-down cleanup waits for the pending cleaner's marker to
// clear before re-claiming. The pending compensating delete is timeout-bounded
// (every SPC call times out at SPC_AUTH_TIMEOUT_MS) and its local marker clear
// commits right after, so a short wait covers the usual overlap and lets the
// re-claim finish the owed cleanup here instead of stranding this request's
// own binding. Past the wait, the request reports the retryable revocation
// and records the fallback marker; the marker's lease bounds the pending
// cleaner (a stale marker is taken over), so no exit leaves the binding
// undiscoverable. Tests tune the wait down.
const CLEANUP_PENDING_WAIT_MS = 2_000;
const CLEANUP_PENDING_POLL_MS = 150;

/**
 * Whether the pending cleaner's marker for this pubkey cleared within a
 * bounded wait. Unreadable state is treated as "did not clear": the caller
 * stands down and reports the retryable revocation.
 */
async function waitForPendingRevocationClear(
  env: Env,
  principalId: string,
  instanceId: string,
  pubkey: string,
  waitMs: number
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CLEANUP_PENDING_POLL_MS));
    if (!(await hasPendingRevocation(env, principalId, instanceId, pubkey))) {
      return true;
    }
  }
  return false;
}

/**
 * After a rejected mirror write, re-read the state that decides the
 * compensating cleanup: whether a revocation won the epoch race while the
 * verification was in flight, whether the identity was disabled meanwhile,
 * and whether a pending-revocation marker still owes a compensating SPC
 * delete (the marker latched this mirror write out, so this request must not
 * surface the raw identity conflict and instead reports the revocation as
 * retryable). Each check is best-effort: a transient read failure leaves the
 * flag undetected.
 */
async function rejectedMirrorState(
  env: Env,
  session: WalletSession,
  observedRevocationEpoch: number,
  pubkey: string
): Promise<{ revokedWhileVerifying: boolean; disabled: boolean; pendingRevocation: boolean }> {
  const { scope, instance, pcUser } = session;
  let revokedWhileVerifying = false;
  try {
    revokedWhileVerifying =
      (await createPrivateChannelVerifiedWalletRepository(env).getRevocationEpoch(
        instance.id,
        pubkey
      )) !== observedRevocationEpoch;
  } catch (statusError) {
    getLogger().warn(
      { principalId: pcUser.id, instanceId: instance.id, statusError },
      "private-channel wallet: could not check the revocation epoch after a rejected mirror"
    );
  }
  // Only undo the SPC binding after a fresh read confirms that exact identity
  // is now disabled; ordinary persistence failures must not remove a valid
  // binding.
  let disabled = false;
  try {
    const current = await createPrivateChannelUserRepository(env).getById(scope, pcUser.id);
    disabled = Boolean(current?.disabled_at);
  } catch (statusError) {
    getLogger().warn(
      { principalId: pcUser.id, instanceId: instance.id, statusError },
      "private-channel wallet: could not check identity state after a rejected mirror"
    );
  }
  const pendingRevocation = await hasPendingRevocation(env, pcUser.id, instance.id, pubkey);
  return { revokedWhileVerifying, disabled, pendingRevocation };
}

/**
 * The compensating cleanup a rejected verification runs after a lost race:
 * claim the cleanup (under the revocation-epoch row lock), and when claimed,
 * revoke the upstream binding this request's verify-wallet created.
 *
 * The winning revocation's SPC delete may have run BEFORE this request's
 * verify-wallet created the upstream binding, so the completed cleanup did not
 * necessarily cover the binding this request just created. The compensating
 * delete is idempotent (SPC answers 400 for an already unlinked wallet and
 * that converges), so it must run after a lost race — but never over a newer
 * verification: the claim stands down when a fresh verification of this
 * identity has already re-created the mirror, and otherwise advances the epoch
 * and records the durable retry marker in the same transaction, so a failed or
 * interrupted SPC delete leaves the late binding recoverable by the next
 * principal-disable cleanup. The claim also stands down while another rejected
 * verification's cleanup for the same binding is still pending (a fresh
 * marker): SPC keeps one binding per (SPC user, pubkey), so that cleaner's
 * single delete covers this request too, and a second concurrent delete would
 * let the first finisher clear the shared marker while the second delete is
 * still in flight — a fresh verification landing in that window would lose its
 * binding and mirror to the outstanding delete. The marker latches the mirror
 * upsert the whole time: a verification that lands afterwards is refused with
 * a retryable conflict and finishes the owed cleanup itself once the claim is
 * free or stale, so the compensating delete can never take a fresh
 * verification's binding.
 *
 * Single best effort: failures are logged; the durable retry marker recorded
 * by the claim keeps the late upstream binding recoverable either way, and
 * every exit that did NOT complete the compensating delete itself — a
 * stand-down whose bounded wait timed out, a re-claim that lost to a newer
 * claimant, an undecided claim — records the fallback marker (best effort)
 * before returning. The record is the repository's decision: it is skipped
 * under the epoch row lock when a mirror that belongs to this identity
 * already exists (a newer verification's binding must survive), so the
 * fallback never latches a mirror that is already there, and it re-owns an
 * existing marker (lease-fresh, preserving the owner's claim epoch) so the
 * pending cleaner's watermark-scoped clear cannot drop the record of this
 * request's still-owed delete.
 */
async function compensateRejectedVerification(
  env: Env,
  session: WalletSession,
  input: { walletId: string; pubkey: string; pendingRevocation: boolean; cleanupWaitMs: number }
): Promise<void> {
  const { scope, instance, pcUser, client, spcAuth } = session;
  const { walletId, pubkey, pendingRevocation, cleanupWaitMs } = input;
  const verifiedWalletRepo = createPrivateChannelVerifiedWalletRepository(env);
  const claimInput = {
    ...scope,
    userId: pcUser.id,
    instanceId: instance.id,
    walletId,
    pubkey,
  };
  let cleanup: "claimed" | "superseded" | "undecided" = "undecided";
  // The claimed marker's ownership watermark: the compensating clear only
  // removes the marker while it still carries this value. A stand-down whose
  // bounded wait timed out re-owns the marker through the fallback record —
  // lease-fresh, so claims keep standing down while the pending cleaner's
  // delete can still be in flight, and preserving its claim epoch, so the
  // latch drops as soon as that owner converges — which is what keeps this
  // request's own late binding recoverable even when the pending cleaner
  // converges after the wait gives up.
  let claimedMarkerUpdatedAt: string | undefined;
  const tryClaim = async (): Promise<"claimed" | "superseded"> => {
    const watermark = await verifiedWalletRepo.claimStaleVerificationCleanup(claimInput);
    if (watermark === null) {
      return "superseded";
    }
    claimedMarkerUpdatedAt = watermark;
    return "claimed";
  };
  try {
    cleanup = await tryClaim();
    if (cleanup === "superseded" && pendingRevocation) {
      // The pending cleaner's delete may already have returned while its
      // marker is still latched, so standing down here could strand a
      // binding this request's own handshake just created with no mirror
      // and no marker. Wait for the marker to clear (or its lease to
      // expire) and re-claim once, finishing the owed cleanup here. A
      // mirror that re-appeared meanwhile makes the re-claim stand down
      // for the newer verification instead.
      if (await waitForPendingRevocationClear(env, pcUser.id, instance.id, pubkey, cleanupWaitMs)) {
        cleanup = await tryClaim();
      }
    }
  } catch (claimError) {
    getLogger().warn(
      { principalId: pcUser.id, instanceId: instance.id, claimError },
      "private-channel wallet: could not claim the late-binding cleanup after a rejected mirror"
    );
    // The claim failed, so nothing is deleted. Retry the claim once first —
    // a transient persistence failure should not latch verifications for a
    // whole marker lease — and leave the fallback decision to the shared
    // exit below. A stand-down for a pending marker whose re-claim then
    // failed must fall back too: this request's own handshake may have
    // created a binding that neither a mirror nor the pending cleaner's
    // delete covers.
    try {
      cleanup = await tryClaim();
    } catch (claimRetryError) {
      getLogger().warn(
        { principalId: pcUser.id, instanceId: instance.id, claimRetryError },
        "private-channel wallet: cleanup claim retry failed after a rejected mirror"
      );
    }
  }
  if (cleanup === "claimed") {
    try {
      await revokeWalletWithSession(
        env,
        { scope, instance, pcUser, client, spcAuth },
        pubkey,
        claimedMarkerUpdatedAt
      );
    } catch (cleanupError) {
      getLogger().warn(
        { principalId: pcUser.id, instanceId: instance.id, cleanupError },
        "private-channel wallet: could not revoke a late binding after a rejected mirror"
      );
    }
    return;
  }
  // Every exit without a completed compensating delete records the fallback
  // marker (best effort): a wait that timed out on a still-fresh marker, a
  // re-claim that lost to a newer claimant, or an undecided claim must all
  // leave the late upstream binding recoverable instead of stranding it with
  // no mirror and no marker. The record re-owns an existing marker (keeping
  // its claim epoch, refreshing its lease) so the pending cleaner's
  // watermark-scoped clear cannot remove the record of this request's
  // still-owed delete, and it skips itself when this identity's mirror
  // already owns the binding — it never latches a mirror that is already
  // there.
  await recordPendingRevocation(env, claimInput);
}

/**
 * The default identity's verified wallets for the project's active instance
 * (empty when no instance is connected). Scoped to the active
 * instance so a verification never leaks across instances.
 */
export async function listPrivateChannelWallets(
  env: Env,
  auth: ApiKeyContext,
  projectId: string
): Promise<PrivateChannelVerifiedWalletRow[]> {
  const scope = { organizationId: auth.organizationId, projectId };
  const instance = await createPrivateChannelInstanceRepository(env).getActiveByProject(scope);
  if (!instance) {
    return [];
  }
  const pcUser = await createPrivateChannelUserRepository(env).findDefaultPrincipal(
    scope,
    instance.id
  );
  if (!pcUser) return [];
  return createPrivateChannelVerifiedWalletRepository(env).listByUserAndInstance(
    pcUser.id,
    instance.id
  );
}

/**
 * Verify one custody wallet with the connected SPC instance's auth service, as
 * the selected project identity's SPC user. Returns the persisted row + the instance (the
 * handler emits events). A member may verify many wallets per instance; the
 * upsert refreshes an existing (user, instance, pubkey) row so re-verify is
 * idempotent.
 */
export async function verifyPrivateChannelWallet(
  env: Env,
  auth: ApiKeyContext,
  projectId: string,
  walletId: string,
  principalId?: string,
  opts?: { cleanupPendingWaitMs?: number }
): Promise<{ row: PrivateChannelVerifiedWalletRow; instance: PrivateChannelInstanceRow }> {
  const wallet = await resolvePrivateChannelCustodyWallet(env, auth, projectId, walletId);
  const signer = await createPrivateChannelSigner(env, auth.organizationId, projectId, wallet);
  if (!isMessagePartialSigner(signer)) {
    throw new AppError("SIGNING_FAILED", "This wallet cannot sign verification messages.");
  }
  const { scope, instance, pcUser, client, spcAuth } = await resolveWalletSession(
    env,
    auth,
    projectId,
    principalId
  );

  // The exact signer is retained across the challenge retry.
  const pubkey = signer.address;

  const verifiedWalletRepo = createPrivateChannelVerifiedWalletRepository(env);
  // The revocation barrier (SOLA9-664): observe the durable revocation epoch
  // for (instance, pubkey) BEFORE the SPC handshake, and let the final mirror
  // upsert refuse unless the epoch is unchanged. A revocation that commits
  // while this verification is in flight advances the epoch, so the stale
  // verification continuation cannot resurrect the mirror after the
  // revocation's SPC delete and mirror removal succeeded.
  const observedRevocationEpoch = await verifiedWalletRepo.getRevocationEpoch(instance.id, pubkey);

  // Retry unit is challenge → sign → verify (restarted from challenge on 401).
  // The nonce is challenge-scoped; never retry verify alone with a fresh token.
  await withSpcAuth(spcAuth, async (token) => {
    const challenge = await client.challengeWallet(token);

    let signature: string;
    try {
      const [signatures] = await signer.signMessages([createSignableMessage(challenge.message)]);
      const signatureBytes = signatures[pubkey];
      if (!signatureBytes) {
        throw new AppError("SIGNING_FAILED", "Signing did not produce a signature for the wallet.");
      }
      signature = base58.decode(signatureBytes);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        "SIGNING_FAILED",
        "The wallet failed to sign the verification challenge.",
        {
          cause: error instanceof Error ? error.message : String(error),
        }
      );
    }

    // SPC enforces UNIQUE(user_id, pubkey) and returns 409 on re-verify. Treat that
    // as success and fall through to the upsert so the SDP mirror stays in sync —
    // makes verify idempotent and self-heals a missing mirror row.
    try {
      await client.verifyWallet(token, {
        pubkey,
        nonce: challenge.nonce,
        signature,
      });
    } catch (error) {
      if (!(error instanceof PrivateChannelError) || error.code !== "CONFLICT") {
        throw error;
      }
    }
  });

  let row: PrivateChannelVerifiedWalletRow;
  try {
    row = await verifiedWalletRepo.upsert({
      ...scope,
      userId: pcUser.id,
      instanceId: instance.id,
      walletId,
      pubkey,
      expectedRevocationEpoch: observedRevocationEpoch,
    });
  } catch (error) {
    const session: WalletSession = { scope, instance, pcUser, client, spcAuth };
    const state = await rejectedMirrorState(env, session, observedRevocationEpoch, pubkey);
    if (state.revokedWhileVerifying || state.disabled || state.pendingRevocation) {
      await compensateRejectedVerification(env, session, {
        walletId,
        pubkey,
        pendingRevocation: state.pendingRevocation,
        cleanupWaitMs: opts?.cleanupPendingWaitMs ?? CLEANUP_PENDING_WAIT_MS,
      });
    }
    if (state.revokedWhileVerifying || state.pendingRevocation) {
      throw conflict(
        "This wallet verification was revoked while it was being verified. Start the verification again."
      );
    }
    throw error;
  }

  return { row, instance };
}

/**
 * Revoke a wallet verification with SPC, then remove the SDP mirror row. Returns
 * the instance (the handler emits events) and whether a mirror row was removed.
 */
export async function deletePrivateChannelWallet(
  env: Env,
  auth: ApiKeyContext,
  projectId: string,
  pubkey: string
): Promise<{ instance: PrivateChannelInstanceRow; deleted: boolean }> {
  const scope = { organizationId: auth.organizationId, projectId };
  const instance = await createPrivateChannelInstanceRepository(env).getActiveByProject(scope);
  requireActiveInstance(instance);
  const mirror = await createPrivateChannelVerifiedWalletRepository(env).findByInstanceAndPubkey(
    scope,
    instance.id,
    pubkey
  );
  if (!mirror) return { instance, deleted: false };

  const session = await resolveWalletSession(env, auth, projectId, mirror.user_id, true);
  const deleted = await revokeWalletWithSession(env, session, pubkey);

  return { instance, deleted };
}

/** Revoke every wallet owned by one identity before removing its channel access. */
export async function revokePrivateChannelPrincipalWallets(
  env: Env,
  auth: ApiKeyContext,
  projectId: string,
  principalId: string
): Promise<string[]> {
  const scope = { organizationId: auth.organizationId, projectId };
  const instance = await createPrivateChannelInstanceRepository(env).getActiveByProject(scope);
  requireActiveInstance(instance);
  const repo = createPrivateChannelVerifiedWalletRepository(env);
  const [wallets, pendingRevocations] = await Promise.all([
    repo.listByUserAndInstance(principalId, instance.id),
    repo.listPendingRevocations(principalId, instance.id),
  ]);
  const pubkeys = [
    ...new Set([
      ...wallets.map((wallet) => wallet.pubkey),
      ...pendingRevocations.map((marker) => marker.pubkey),
    ]),
  ];
  if (pubkeys.length === 0) return [];

  const session = await resolveWalletSession(env, auth, projectId, principalId, true);
  for (const pubkey of pubkeys) {
    await revokeWalletWithSession(env, session, pubkey);
  }
  return pubkeys;
}
