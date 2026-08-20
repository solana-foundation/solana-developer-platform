import type { EarnMovementRecord, EarnMovementsPage } from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
} from "@/db/repositories/earn-movements.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import type { AppContext } from "../context";
import { resolveSdpEnvironment } from "../context";
import { earnMovementsQuerySchema } from "../schemas";
import { parseQuery } from "./shared";
import { listReadableEarnVaultWallets } from "./vault";

/**
 * GET /v1/earn/movements — every money movement this workspace made through
 * Earn, newest first, across providers and execution models.
 *
 * The read the two per-family lists could not give: `/programs/:id/withdrawals`
 * answers for ONE custodial program and `/vault-deposits` for signed deposits,
 * so "what moved on this organization" previously meant paging several endpoints
 * and merging them client-side — and getting the merge right required knowing
 * which vocabulary each one spoke. This is one list, one vocabulary, one cursor.
 *
 * NO provider gate, for the same ADR 0002 reason as the reads it generalises:
 * this reports on money that has already moved. Un-offering a provider, removing
 * its credentials, or un-entitling an organization closes the door IN and must
 * never take away the record of what already went through it.
 *
 * Visibility is the UNION of what those per-family reads already grant, and is
 * enforced in the repository query: vault rows stay project-and-wallet scoped,
 * custodial rows stay program scoped. A new endpoint must not become a way to see
 * more than the old ones showed.
 */
export async function listEarnMovements(c: AppContext) {
  const query = parseQuery(c, earnMovementsQuerySchema);
  const before = query.before ? decodeMovementCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid earn movement pagination cursor");
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  // Resolved before the query, exactly as the vault reads do: a key bound to
  // particular wallets must not learn of movements signed by others. An empty
  // result here is not "no scope" — custodial movements remain visible, because
  // program wallets carry no such binding.
  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  const custodyWalletIds = [...new Set(scopedWallets.map((wallet) => wallet.id))];

  const { rows, hasMore } = await createPostgresEarnMovementsRepository(getDb(c.env)).listMovements(
    {
      organizationId: auth.organizationId,
      environment,
      projectId,
      custodyWalletIds,
      limit: query.limit,
      before,
      direction: query.direction,
      status: query.status,
      provider: query.provider,
      positionId: query.positionId,
      sourceAddress: query.sourceAddress,
      destinationAddress: query.destinationAddress,
    }
  );

  const last = rows.at(-1);
  const response: EarnMovementsPage = {
    movements: rows.map(toEarnMovementRecord),
    hasMore,
    nextCursor: hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null,
  };
  return success(c, response);
}

/**
 * The ledger row as the wire sees it, in the ledger's own vocabulary — no status
 * translation, because this contract has no existing client to keep compatible.
 *
 * Absent rather than null for every optional field, matching the rest of the Earn
 * surface. Four columns are deliberately never exposed: the signed transaction
 * bytes (an internal outbox payload), the blockhash height that bounds them, the
 * idempotency fingerprint, and the caller's request id — none of which describe
 * the money that moved.
 */
function toEarnMovementRecord(row: EarnMovementRow): EarnMovementRecord {
  return {
    id: row.id,
    provider: row.provider,
    executionModel: row.execution_model,
    direction: row.direction,
    status: row.status,
    positionId: row.position_id,
    denomination: row.denomination,
    amountRequested: row.amount_requested,
    amountSettled: row.amount_settled ?? undefined,
    feeAmount: row.fee_amount ?? undefined,
    minSharesOut: row.min_shares_out ?? undefined,
    sharesOut: row.shares_out ?? undefined,
    payoutToken: row.payout_token ?? undefined,
    vaultAddress: row.vault_address ?? undefined,
    sourceAddress: row.source_address ?? undefined,
    destinationAddress: row.destination_address ?? undefined,
    providerReference: row.provider_reference ?? undefined,
    signature: row.signature ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    createdBy: row.created_by ?? undefined,
    initiatedByKeyId: row.initiated_by_key_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at ?? undefined,
    settledAt: row.settled_at ?? undefined,
  };
}

/**
 * The id half is validated only for shape, not for a known prefix.
 *
 * Movement ids are heterogeneous by design — the projection PRESERVED each legacy
 * row's id, so the feed carries `earn_vault_movement_…` and
 * `earn_program_withdrawal_…` side by side, and will carry `earn_movement_…` for
 * anything minted after the legacy writers retire. Pinning a prefix here would
 * mean revisiting this cursor every time that set changes.
 *
 * Safe because the cursor is a pagination BOUND, not an access grant: it lands in
 * `(created_at, id) < (?, ?)` while organization, environment and wallet scope are
 * separate conditions. A forged cursor can only reposition a caller within rows it
 * could already read.
 */
const movementCursorSchema = z.object({
  createdAt: z.iso.datetime({ precision: 3 }),
  id: z.string().min(1).max(128),
});

function decodeMovementCursor(cursor: string): { createdAt: string; id: string } | null {
  const decoded = decodeKeysetCursor(cursor);
  if (!decoded) return null;
  const parsed = movementCursorSchema.safeParse({ createdAt: decoded.value, id: decoded.id });
  return parsed.success ? parsed.data : null;
}
