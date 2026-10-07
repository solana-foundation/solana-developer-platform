import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { notFound, providerUnavailable } from "@/lib/errors";
import type { Env } from "@/types/env";
import { assertClusterEndpoint, earnClusterFor, resolveClusterRpcUrl } from "./execution-registry";

/** How long a finalized signature's status is reused before it is read again. */
export const FINALIZED_SIGNATURE_STATUS_TTL_MS = 600_000;
const FINALIZED_SIGNATURE_STATUS_CAPACITY = 1_024;

/**
 * A finalized signature's slot and error never change, so polls that keep
 * naming the same movement skip `getSignatureStatuses` for it. Keyed by
 * cluster and signature, and filled only with a status read from the RPC that
 * passed every check below; a confirmed-only status is always read again.
 */
const finalizedStatuses = new Map<string, { status: SignatureStatusInfo; expiresAt: number }>();

/** Test seam: forget the memoised finalized statuses. */
export function resetFinalizedSignatureStatuses(): void {
  finalizedStatuses.clear();
}

function finalizedStatus(key: string): SignatureStatusInfo | undefined {
  const entry = finalizedStatuses.get(key);
  if (!entry) return undefined;
  finalizedStatuses.delete(key);
  if (entry.expiresAt <= Date.now()) return undefined;
  finalizedStatuses.set(key, entry);
  return entry.status;
}

function rememberFinalizedStatus(key: string, status: SignatureStatusInfo): void {
  finalizedStatuses.delete(key);
  finalizedStatuses.set(key, {
    status,
    expiresAt: Date.now() + FINALIZED_SIGNATURE_STATUS_TTL_MS,
  });
  while (finalizedStatuses.size > FINALIZED_SIGNATURE_STATUS_CAPACITY) {
    const oldest = finalizedStatuses.keys().next().value;
    if (oldest === undefined) break;
    finalizedStatuses.delete(oldest);
  }
}

export async function resolveVaultBalanceReadContext(
  env: Env,
  input: {
    movementIds: readonly string[];
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    custodyWalletIds: readonly string[];
  }
): Promise<
  | {
      afterMovementIds: string[];
      minimumSlot: number;
      minimumSlotByPositionId: ReadonlyMap<string, number>;
    }
  | undefined
> {
  if (input.movementIds.length === 0) return undefined;
  const repo = createPostgresEarnMovementsRepository(getDb(env));
  const afterMovementIds = [...new Set(input.movementIds)];
  const movements = [];
  // Scope every movement before any chain request. A foreign id never becomes
  // a timing oracle for another project's or selected wallet's transaction.
  for (const movementId of afterMovementIds) {
    const movement = await repo.getMovementById({
      movementId,
      organizationId: input.organizationId,
    });
    if (
      movement?.execution_model !== "vault_direct" ||
      movement.environment !== input.environment ||
      movement.project_id !== input.projectId ||
      !movement.custody_wallet_id ||
      !input.custodyWalletIds.includes(movement.custody_wallet_id)
    ) {
      throw notFound("Earn vault movement");
    }
    if (!movement.signature || !movement.position_id)
      throw providerUnavailable("Earn balance confirmation is unavailable");
    movements.push(movement);
  }
  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  await assertClusterEndpoint(env, cluster, rpcUrl);
  const keys = movements.map((movement) => `${cluster}\n${movement.signature}`);
  const statuses: Array<SignatureStatusInfo | null | undefined> = keys.map(finalizedStatus);
  const unread = movements.flatMap((movement, index) =>
    statuses[index] ? [] : [{ index, signature: movement.signature as Signature }]
  );
  if (unread.length > 0) {
    const rpc = createRpc(env, { rpcUrl, requestTimeoutMs: 3_000 });
    const read = await getSignatureStatuses(
      rpc,
      unread.map(({ signature }) => signature),
      { searchTransactionHistory: true, retryDelaysMs: [] }
    );
    if (read.length !== unread.length) {
      throw providerUnavailable("Earn balance confirmation is unavailable");
    }
    unread.forEach(({ index }, position) => {
      statuses[index] = read[position];
    });
  }
  const readNow = new Set(unread.map(({ index }) => index));
  let minimumSlot = 0;
  const minimumSlotByPositionId = new Map<string, number>();
  for (const [index, status] of statuses.entries()) {
    const slot = Number(status?.slot);
    if (
      !status ||
      status.err !== null ||
      !["confirmed", "finalized"].includes(status.confirmationStatus ?? "") ||
      !Number.isSafeInteger(slot) ||
      slot < 0
    ) {
      throw providerUnavailable("Earn balance confirmation is unavailable");
    }
    if (readNow.has(index) && status.confirmationStatus === "finalized") {
      rememberFinalizedStatus(keys[index], status);
    }
    minimumSlot = Math.max(minimumSlot, slot);
    const positionId = movements[index]?.position_id;
    if (positionId) {
      minimumSlotByPositionId.set(
        positionId,
        Math.max(minimumSlotByPositionId.get(positionId) ?? 0, slot)
      );
    }
  }
  return { afterMovementIds, minimumSlot, minimumSlotByPositionId };
}
