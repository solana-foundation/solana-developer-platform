/**
 * SPC wallet-verification orchestration (the write path) + the per-member read.
 *
 * Drives the SPC auth handshake for one SDP custody wallet:
 *   1. resolve the connected instance + the acting member's SPC user
 *   2. open an SPC JWT handle (KV-cached via ./auth/gateway-auth)
 *   3. `challenge-wallet` → sign the challenge with THAT wallet → `verify-wallet`
 *   4. persist the verification (idempotent per (user, instance, pubkey))
 *
 * Signing is wallet-specific via `createOrgSigner(...walletId)` (not
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
import { AppError, forbidden, providerNotConfigured } from "@/lib/errors";
import { createOrgSigner } from "@/services/solana";
import type { Env } from "@/types/env";
import { openSpcAuthContext, type SpcAuthContext, withSpcAuth } from "./auth/gateway-auth";

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
 * Shared preamble for the verify/delete write paths: require a user identity,
 * resolve the connected instance and the acting member's SPC user, and open a
 * cached SPC JWT handle.
 */
async function resolveWalletSession(
  env: Env,
  auth: ApiKeyContext,
  projectId: string
): Promise<WalletSession> {
  if (!auth.userId) {
    throw forbidden(
      "Managing verified wallets requires a user identity and is not available for API-key auth."
    );
  }
  const scope = { organizationId: auth.organizationId, projectId };

  const instance = await createPrivateChannelInstanceRepository(env).getActiveByProject(scope);
  requireActiveInstance(instance);

  const pcUser = await createPrivateChannelUserRepository(env).findByProjectAndUser(
    scope,
    auth.userId
  );
  if (!pcUser) {
    throw forbidden("You must be an invited Private Channels member to manage verified wallets.");
  }

  const client = createAuthClient(instance.auth_url, { timeoutMs: SPC_AUTH_TIMEOUT_MS });
  const spcAuth = await openSpcAuthContext(env, auth.organizationId, instance.id, pcUser, client);

  return { scope, instance, pcUser, client, spcAuth };
}

/**
 * The acting member's verified wallets for the project's active instance (empty
 * for non-members or when no instance is connected). Scoped to the active
 * instance so a verification never leaks across instances.
 */
export async function listPrivateChannelWallets(
  env: Env,
  auth: ApiKeyContext,
  projectId: string
): Promise<PrivateChannelVerifiedWalletRow[]> {
  if (!auth.userId) {
    return [];
  }
  const scope = { organizationId: auth.organizationId, projectId };
  const pcUser = await createPrivateChannelUserRepository(env).findByProjectAndUser(
    scope,
    auth.userId
  );
  if (!pcUser) {
    return [];
  }
  const instance = await createPrivateChannelInstanceRepository(env).getActiveByProject(scope);
  if (!instance) {
    return [];
  }
  return createPrivateChannelVerifiedWalletRepository(env).listByUserAndInstance(
    pcUser.id,
    instance.id
  );
}

/**
 * Verify one custody wallet with the connected SPC instance's auth service, as
 * the acting member's SPC user. Returns the persisted row + the instance (the
 * handler emits events). A member may verify many wallets per instance; the
 * upsert refreshes an existing (user, instance, pubkey) row so re-verify is
 * idempotent.
 */
export async function verifyPrivateChannelWallet(
  env: Env,
  auth: ApiKeyContext,
  projectId: string,
  walletId: string
): Promise<{ row: PrivateChannelVerifiedWalletRow; instance: PrivateChannelInstanceRow }> {
  const { scope, instance, pcUser, client, spcAuth } = await resolveWalletSession(
    env,
    auth,
    projectId
  );

  // Resolve the wallet to a signer BEFORE the SPC challenge, so an
  // invalid/unsignable wallet fails without minting a nonce. Kept outside
  // withSpcAuth so a 401 retry does not re-derive the signer.
  const signer = await createOrgSigner(env, auth.organizationId, projectId, walletId);
  if (!isMessagePartialSigner(signer)) {
    throw new AppError("SIGNING_FAILED", "This wallet cannot sign verification messages.");
  }
  const pubkey = signer.address;

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

  const row = await createPrivateChannelVerifiedWalletRepository(env).upsert({
    ...scope,
    userId: pcUser.id,
    instanceId: instance.id,
    walletId,
    pubkey,
  });

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
  const { instance, pcUser, client, spcAuth } = await resolveWalletSession(env, auth, projectId);

  // SPC's delete returns 400 ("wallet not associated with this user") when the
  // pubkey is already unlinked or never existed — the only non-401/500 status that
  // endpoint emits, so it's unambiguous (SPC never 404s here). Treat that 400 as
  // already-revoked and still drop the SDP mirror row so the two systems converge;
  // rethrow other failures (auth, unavailable, …).
  await withSpcAuth(spcAuth, async (token) => {
    try {
      await client.deleteWallet(token, pubkey);
    } catch (error) {
      if (!(error instanceof PrivateChannelError) || error.code !== "BAD_REQUEST") {
        throw error;
      }
    }
  });

  const deleted = await createPrivateChannelVerifiedWalletRepository(
    env
  ).deleteByUserInstanceAndPubkey(pcUser.id, instance.id, pubkey);

  return { instance, deleted };
}
