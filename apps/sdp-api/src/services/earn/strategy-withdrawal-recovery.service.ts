import type {
  EarnVaultQueuedWithdrawalRequestLookup,
  EarnVaultQueuedWithdrawProvider,
} from "@sdp/earn/types";
import { currentClusterScope } from "@sdp/rpc/scope";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import { isLiveVaultWithdrawalRequestStatus } from "@sdp/types/earn";
import { getDb } from "@/db/client";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestRow,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { conflict, serviceUnavailable } from "@/lib/errors";
import type { Env } from "@/types/env";
import { resolveVaultQueuedWithdrawClient } from "./execution-registry";
import { earnRuntime } from "./runtime";
import { createVaultDeadline } from "./vault-deadline";
import type {
  QueuedWithdrawalActor,
  QueuedWithdrawalPosition,
} from "./vault-queued-withdraw.service";

const MAX_RECOVERY_CANDIDATES = 3;

/** Live evidence belongs only to this preparation call and is never persisted. */
export interface ProvenStrategyWithdrawalRecovery {
  request: EarnVaultWithdrawalRequestRow;
  proof: EarnVaultQueuedWithdrawalRequestLookup;
}

/** A recovery may return only the recorded position's escrow to its owner. */
export function assertStrategyRecoverySource(
  request: EarnVaultWithdrawalRequestRow,
  actor: QueuedWithdrawalActor,
  position: QueuedWithdrawalPosition
): void {
  if (
    request.organization_id !== actor.organizationId ||
    request.project_id !== actor.projectId ||
    request.environment !== currentClusterScope().environment ||
    request.position_id !== position.id ||
    request.provider !== position.provider ||
    request.vault_address !== position.vaultAddress ||
    request.owner_address !== position.ownerAddress ||
    request.custody_wallet_id !== (position.custodyWalletId ?? null) ||
    request.token_mint !== position.tokenMint ||
    request.share_mint !== position.shareMint ||
    request.mechanism !== "solver_queue"
  )
    throw conflict("Expired escrow does not match the withdrawal position and source");
}

/** Expiry alone is insufficient: the same live request cycle must retain its shares. */
export function assertExpiredStrategyEscrow(
  request: EarnVaultWithdrawalRequestRow,
  lookup: EarnVaultQueuedWithdrawalRequestLookup
): void {
  if (
    !isLiveVaultWithdrawalRequestStatus(request.status) ||
    request.nonce === null ||
    request.creation_timestamp === null ||
    request.deadline_timestamp === null ||
    lookup.status !== "expiredCancelable" ||
    lookup.request.status !== "expiredCancelable"
  )
    throw conflict("The recorded withdrawal has no proven expired escrow to recover");
  const live = lookup.request;
  if (
    lookup.requestAddress !== request.request_address ||
    live.requestAddress !== request.request_address ||
    live.providerReference !== request.vault_address ||
    live.owner !== request.owner_address ||
    live.assetMint !== request.token_mint ||
    live.nonce !== request.nonce ||
    live.creationTimestamp !== request.creation_timestamp ||
    live.maturityTimestamp !== request.maturity_timestamp ||
    live.deadlineTimestamp !== request.deadline_timestamp ||
    compareDecimalAmounts(live.shares, request.shares) !== 0 ||
    compareDecimalAmounts(live.assets, request.quoted_assets) !== 0 ||
    compareDecimalAmounts(live.shares, "0") <= 0 ||
    BigInt(live.deadlineTimestamp) >= BigInt(Math.floor(Date.now() / 1000))
  )
    throw conflict("Live escrow identity or deadline differs from the recorded withdrawal");
}

/** Offer the oldest recoverable escrow, skipping stale candidates without changing history. */
export async function readExpiredStrategyWithdrawalRecoveries(
  env: Env,
  input: { actor: QueuedWithdrawalActor; position: QueuedWithdrawalPosition },
  client: EarnVaultQueuedWithdrawProvider | null = resolveVaultQueuedWithdrawClient(
    env,
    input.position.provider,
    createVaultDeadline()
  )
): Promise<ProvenStrategyWithdrawalRecovery[]> {
  if (client === null) return [];
  const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const scope = {
    organizationId: input.actor.organizationId,
    projectId: input.actor.projectId,
    environment: currentClusterScope().environment,
    positionId: input.position.id,
    ownerAddress: input.position.ownerAddress,
    custodyWalletId: input.position.custodyWalletId ?? null,
    beforeUnixSeconds: String(Math.floor(Date.now() / 1000)),
  };
  let after: { createdAt: string; id: string } | undefined;
  for (let checked = 0; checked < MAX_RECOVERY_CANDIDATES; checked++) {
    const request = await repository.findOldestExpiredEscrow({ ...scope, after });
    if (request === null) return [];
    assertStrategyRecoverySource(request, input.actor, input.position);
    const lookup = await client.readQueuedWithdrawalRequest(earnRuntime(env), {
      providerReference: request.vault_address,
      requestAddress: request.request_address,
    });
    if (lookup.status === "expiredCancelable") {
      assertExpiredStrategyEscrow(request, lookup);
      return [{ request, proof: lookup }];
    }
    after = { createdAt: request.created_at, id: request.id };
  }
  // An unchecked candidate is deferred, not proof that no recovery exists.
  if ((await repository.findOldestExpiredEscrow({ ...scope, after })) !== null)
    throw serviceUnavailable("Withdrawal recovery state is catching up. Try again.");
  return [];
}
