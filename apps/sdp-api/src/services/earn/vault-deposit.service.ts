import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import { address } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnVaultRepository,
  type EarnVaultMovementRow,
  type EarnVaultPositionRow,
} from "@/db/repositories/earn-vault.repository";
import { badRequest } from "@/lib/errors";
import { buildEarnVaultDepositFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import {
  assertClusterEndpoint,
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultDirectClient,
} from "./execution-registry";
import {
  broadcastVaultTransaction,
  type SignedVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
} from "./vault-execution.service";

/**
 * Deposit into a non-custodial vault from an SDP custody wallet.
 *
 * Order of operations is the point, and it mirrors
 * `services/private-channels/deposit.ts`:
 *
 *   1. write the intent row (idempotency anchor) BEFORE anything is signed
 *   2. build the plan from the provider
 *   3. simulate — a third-party SDK assembled these accounts against live state
 *   4. sign with custody and submit
 *   5. advance the ledger by guarded CAS
 *
 * Step 1 first is not bookkeeping pedantry: the chain has no request-id dedupe,
 * so if the process dies between signing and recording, the row written here is
 * the only evidence the transfer happened.
 */

export interface VaultDepositInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** Vault address — the strategy's providerReference. */
  providerReference: string;
  wallet: CustodyWallet;
  /** Decimal string in the vault token's units. */
  amount: string;
  /** Caller idempotency key. REQUIRED — see the migration header. */
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  /** Slippage floor, decimal string. */
  minSharesOut?: string;
}

export interface VaultDepositResult {
  position: EarnVaultPositionRow;
  movement: EarnVaultMovementRow;
  /** True when the idempotency key had already been used — nothing was re-sent. */
  replayed: boolean;
}

export async function depositIntoVault(
  env: Env,
  input: VaultDepositInput
): Promise<VaultDepositResult> {
  const client = resolveVaultDirectClient(env, input.provider);
  if (!client) {
    // Same taxonomy the earn routes already raise, so the existing error
    // handler maps it to a clean 501 rather than a generic 500.
    throw notImplemented(input.provider as never, "direct vault deposits");
  }

  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  // Proves the endpoint serves THIS cluster before anything is built against
  // it. One process serves both environments, so an endpoint configured for the
  // other one would otherwise build a transaction addressed to the wrong chain
  // — and that failure is silent, because Kamino's mainnet program id also
  // resolves on devnet with no accounts under it. Cached per endpoint, so this
  // is one round trip per process, not per deposit.
  await assertClusterEndpoint(env, cluster, rpcUrl);

  const repo = createPostgresEarnVaultRepository(getDb(env));
  const runtime: EarnRuntimeContext = {
    env: env as unknown as Record<string, string | undefined>,
    environment: input.environment,
  };

  // 1. RESOLVE THE REPLAY FIRST — before the position is claimed.
  //
  // The order here is the fix, not decoration. Claiming the position first
  // meant a request reusing a key with a DIFFERENT vault wrote (or reopened) a
  // real position row for the new vault and only then discovered the key was
  // taken — answering with the new `positionId` beside the ORIGINAL movement's
  // status and signature. That response is not merely stale, it describes a
  // transaction that never touched the position it names.
  //
  // Comparing the fingerprint is what separates a genuine retry from a
  // different request wearing the same key: the first replays, the second 409s
  // and writes nothing at all.
  const fingerprint = buildEarnVaultDepositFingerprint({
    environment: input.environment,
    provider: input.provider,
    providerReference: input.providerReference,
    custodyWalletId: input.wallet.id,
    amount: input.amount,
    minSharesOut: input.minSharesOut ?? null,
  });

  const priorMovement = await resolveIdempotencyReplay(
    () =>
      repo.findMovementByRequestId({
        organizationId: input.organizationId,
        requestId: input.requestId,
      }),
    fingerprint
  );
  if (priorMovement) {
    const priorPosition = await repo.getPositionById({
      organizationId: input.organizationId,
      environment: input.environment,
      positionId: priorMovement.position_id,
    });
    if (!priorPosition) {
      // The FK makes this unreachable; if it ever fires, the ledger is
      // inconsistent and guessing would be worse than failing.
      throw new Error(
        `Replayed movement ${priorMovement.id} references missing position ${priorMovement.position_id}`
      );
    }
    // A replay must NOT move money again. Return what the original attempt did.
    return { position: priorPosition, movement: priorMovement, replayed: true };
  }

  // 2. Claim the position and write the intent row.
  //
  // NOTE the two different wallet identifiers, which are easy to confuse and
  // fail in different ways: `wallet.id` is the SDP row (`cwlt_…`) and is what
  // the FK on both tables points at, while `wallet.walletId` is the PROVIDER's
  // own id (`privy_…`) and is what the signing service resolves an adapter by.
  // Swapping them yields a foreign-key violation here and a "wallet not found"
  // at signing time.
  const position = await repo.claimPosition({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    provider: input.provider,
    providerReference: input.providerReference,
    custodyWalletId: input.wallet.id,
    createdBy: input.userId ?? null,
  });

  const { row: movement, replayed } = await repo.createMovement({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    positionId: position.id,
    provider: input.provider,
    providerReference: input.providerReference,
    custodyWalletId: input.wallet.id,
    direction: "deposit",
    requestId: input.requestId,
    idempotencyFingerprint: fingerprint,
    amount: input.amount,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });

  // Lost a race with a concurrent IDENTICAL request (the differing-intent case
  // threw above and inside createMovement). The winner owns the money movement.
  if (replayed) {
    return { position, movement, replayed: true };
  }

  const fail = async (reason: string) => {
    const failed = await repo.advanceMovement({
      movementId: movement.id,
      organizationId: input.organizationId,
      fromStatuses: ["pending"],
      toStatus: "failed",
      failureReason: reason,
    });
    return { position, movement: failed ?? movement, replayed: false };
  };

  // 2. Build.
  let plan: Awaited<ReturnType<typeof client.buildVaultDeposit>>;
  try {
    plan = await client.buildVaultDeposit(runtime, {
      providerReference: input.providerReference,
      owner: input.wallet.publicKey,
      amount: input.amount,
      ...(input.minSharesOut === undefined ? {} : { minSharesOut: input.minSharesOut }),
    });
  } catch (error) {
    getLogger().error({ movementId: movement.id, error }, "vault deposit: build failed");
    return await fail(error instanceof Error ? error.message : "Failed to build the deposit.");
  }

  // 3. Simulate before signing — cheaper than a landed failure the customer paid for.
  const simulation = await simulateVaultPlan(env, {
    plan,
    owner: address(input.wallet.publicKey),
    rpcUrl,
  });
  if (!simulation.ok) {
    getLogger().error(
      { movementId: movement.id, error: simulation.error, logs: simulation.logs.slice(-5) },
      "vault deposit: simulation failed"
    );
    return await fail(`Simulation failed: ${simulation.error}`);
  }

  // 4. Sign with custody and submit.
  const signer = await solanaServices.createOrgSigner(
    env,
    input.organizationId,
    input.projectId,
    input.wallet.walletId
  );
  if (signer.address !== input.wallet.publicKey) {
    // The same assertion private-channels makes: a resolved signer that is not
    // the wallet we priced the deposit for would move someone else's money.
    throw badRequest("Resolved signing wallet does not match the deposit wallet");
  }

  // 5. SIGN, RECORD, THEN BROADCAST — in that order, and the order is the point.
  //
  // Signing determines the signature; broadcasting only publishes it. Writing
  // the signature down BEFORE the bytes can reach the network is what makes an
  // ambiguous send recoverable: if the process dies, or the RPC accepts the
  // transaction and the response is lost, there is a row naming the exact
  // transaction to go and look for. Recording it afterwards — as this did —
  // leaves a window where money has moved and SDP holds no evidence it exists.
  let signed: SignedVaultTransaction;
  try {
    signed = await signVaultPlan(env, { plan, owner: signer, rpcUrl });
  } catch (error) {
    // Nothing was broadcast, so this is a definitive failure.
    getLogger().error({ movementId: movement.id, error }, "vault deposit: signing failed");
    return await fail(error instanceof Error ? error.message : "Failed to sign the deposit.");
  }

  await repo.advanceMovement({
    movementId: movement.id,
    organizationId: input.organizationId,
    fromStatuses: ["pending"],
    // Deliberately still `pending`: nothing has been sent yet. What changes is
    // that the row now carries the signature, so a crash between here and the
    // send leaves a "pending WITH a signature" row — the state a reconciler can
    // resolve by asking the chain, rather than an untraceable orphan.
    toStatus: "pending",
    signature: signed.signature,
  });

  try {
    await broadcastVaultTransaction(env, { bytes: signed.bytes, rpcUrl });
  } catch (error) {
    // A send error does NOT mean the transaction failed — it may have landed
    // and the response been lost. Marking this `failed` would assert that no
    // money moved, which is exactly the claim we cannot make. Leave it pending
    // with its signature so the outcome can be established from the chain.
    getLogger().error(
      { movementId: movement.id, signature: signed.signature, error },
      "vault deposit: broadcast outcome unknown; left reconcilable"
    );
    const pending = await repo.getMovementById({
      movementId: movement.id,
      organizationId: input.organizationId,
    });
    return { position, movement: pending ?? movement, replayed: false };
  }

  // 6. Advance. Guarded so a concurrent observer cannot regress the row.
  const advanced = await repo.advanceMovement({
    movementId: movement.id,
    organizationId: input.organizationId,
    fromStatuses: ["pending"],
    toStatus: "submitted",
    signature: signed.signature,
  });

  return { position, movement: advanced ?? movement, replayed: false };
}

/*
 * WHO PAYS THE TRANSACTION FEE — the custody wallet, unconditionally.
 *
 * Kora only sponsors transactions whose programs are on its allowlist, and the
 * Kamino kvault/klend programs are not on it (the Private Channels escrow hit
 * exactly this and still pays its own fee today). Attempting sponsorship would
 * fail at the relay with an opaque rejection AFTER the customer's wallet had
 * already signed.
 *
 * The sponsored path is deliberately NOT reachable from here any more. It
 * cannot satisfy the record-before-broadcast rule above: the relay signs as fee
 * payer after SDP does, so the final signature is not knowable before the bytes
 * leave — which is precisely the window that made an ambiguous send
 * untraceable. Turning sponsorship on therefore owes two things, not one: the
 * kvault/klend/farms ids added to `validation_config.allowed_programs` in
 * sdp-infra, AND a relay handshake that returns the signature before broadcast
 * (or a ledger state that records the intent-to-sponsor first).
 * `submitVaultPlan` in vault-execution.service.ts still carries the sponsored
 * plumbing for when that lands.
 */
