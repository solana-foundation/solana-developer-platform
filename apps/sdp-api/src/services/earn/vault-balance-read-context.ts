import { createRpc, getSignatureStatuses } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { notFound, providerUnavailable } from "@/lib/errors";
import type { Env } from "@/types/env";
import { assertClusterEndpoint, earnClusterFor, resolveClusterRpcUrl } from "./execution-registry";

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
  const rpc = createRpc(env, { rpcUrl, requestTimeoutMs: 3_000 });
  const statuses = await getSignatureStatuses(
    rpc,
    movements.map((movement) => movement.signature as Signature),
    { searchTransactionHistory: true, retryDelaysMs: [] }
  );
  if (statuses.length !== movements.length) {
    throw providerUnavailable("Earn balance confirmation is unavailable");
  }
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
