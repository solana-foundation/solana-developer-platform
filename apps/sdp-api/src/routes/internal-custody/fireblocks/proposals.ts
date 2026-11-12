import {
  type FireblocksProposalSummary,
  isFireblocksProposalCancellable,
} from "@sdp/types/fireblocks";
import { Hono } from "hono";
import { getDb } from "@/db/client";
import {
  FireblocksProposalsRepository,
  type FireblocksSigningProposalRow,
} from "@/db/repositories/fireblocks-proposals.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { getAuth, requireProjectId, walletAccessAllows } from "@/lib/auth";
import { conflict, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AuthorizeInput, authorize, getAuthorized } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { requireAction } from "@/middleware/require-action";
import { validateParams, validateQuery } from "@/middleware/validate";
import type { AppContext } from "@/routes/custody/context";
import { getPaymentsRepository, requestProposalLedger } from "@/routes/payments/context";
import { getLogger } from "@/runtime/logger";
import { describeError } from "@/runtime/money-path-events";
import { AuditService } from "@/services/audit.service";
import {
  fireblocksSigningBinding,
  pollFireblocksSigningProposal,
  readFireblocksSigningProposal,
} from "@/services/custody/fireblocks-proposal-reconciliation";
import {
  cancelPendingFireblocksTransfer,
  isFireblocksTransfer,
  refreshFireblocksTransfer,
} from "@/services/payments/fireblocks-transfer";
import { createOrgTransferProposalCanceller } from "@/services/solana/signer";
import type { Env } from "@/types/env";

import { cancelFireblocksProposalParams, listFireblocksProposalsSchema } from "./schemas";

function scope(c: AppContext) {
  return { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) };
}
function proposals(c: AppContext) {
  return new FireblocksProposalsRepository(getDb(c.env), scope(c));
}

async function authorizeWallet(c: AppContext, walletId: string): Promise<void> {
  const auth = getAuth(c);
  const owned = await getDb(c.env).queryOne<{ id: string }>(
    `SELECT w.id FROM custody_wallets w JOIN custody_connections cc ON cc.id = w.custody_connection_id
     WHERE w.id = ? AND cc.organization_id = ? AND cc.project_id = ? AND cc.provider = 'fireblocks'`,
    [walletId, auth.organizationId, requireProjectId(c)]
  );
  if (!owned || !walletAccessAllows(auth.walletAccess, owned.id))
    throw notFound("Fireblocks wallet");
}

function signingSummary(row: FireblocksSigningProposalRow): FireblocksProposalSummary {
  return {
    id: row.id,
    kind: "signing",
    operation: row.operation,
    status: row.status,
    transactionId: row.provider_transaction_id,
    createdAt: row.created_at,
    cancellationRequestedAt: row.cancel_requested_at,
    canCancel:
      !row.finished_at &&
      (row.status === "SUBMITTING" || isFireblocksProposalCancellable(row.status)),
  };
}
function transferSummary(row: PaymentTransferRow): FireblocksProposalSummary {
  const status =
    typeof row.provider_data.fireblocksStatus === "string"
      ? row.provider_data.fireblocksStatus
      : "SUBMITTING";
  return {
    id: row.id,
    kind: "transfer",
    operation: "TRANSFER",
    status,
    transactionId: row.provider_reference,
    createdAt: row.created_at,
    cancellationRequestedAt:
      typeof row.provider_data.fireblocksCancelRequestedAt === "string"
        ? row.provider_data.fireblocksCancelRequestedAt
        : null,
    canCancel:
      row.status === "processing" &&
      (status === "SUBMITTING" || isFireblocksProposalCancellable(status)),
  };
}

async function refreshSigning(c: AppContext, row: FireblocksSigningProposalRow) {
  try {
    return (await pollFireblocksSigningProposal(c.env, proposals(c), row)).row;
  } catch (error) {
    getLogger().warn(
      { proposalId: row.id, ...describeError(error) },
      "fireblocks_proposal_status_unavailable"
    );
    return proposals(c).require(row.id);
  }
}

type Cancellation =
  | { kind: "signing"; row: FireblocksSigningProposalRow }
  | { kind: "transfer"; row: PaymentTransferRow };
async function authorizeCancellation(c: AppContext, input: AuthorizeInput): Promise<Cancellation> {
  const { kind, proposalId } = cancelFireblocksProposalParams.parse(input.params);
  if (kind === "signing") {
    const row = await proposals(c).require(proposalId);
    await authorizeWallet(c, row.custody_wallet_id);
    return { kind, row };
  }
  const row = await getPaymentsRepository(c).getTransferById({
    ...scope(c),
    transferId: proposalId,
  });
  if (!row?.custody_wallet_id || !isFireblocksTransfer(row)) throw notFound("Fireblocks proposal");
  await authorizeWallet(c, row.custody_wallet_id);
  return { kind, row };
}
async function cancelSigning(c: AppContext, row: FireblocksSigningProposalRow) {
  if (!(await proposals(c).requestCancellation(row.id)))
    return {
      acknowledged: false,
      proposal: signingSummary(await proposals(c).require(row.id)),
    };
  // Claim before talking to Fireblocks: even a late SIGNED response must not reach SDP's broadcaster.
  const canceller = await createOrgTransferProposalCanceller(
    c.env,
    row.organization_id,
    row.project_id,
    row.custody_wallet_id,
    fireblocksSigningBinding(row)
  );
  const before = await readFireblocksSigningProposal(c.env, proposals(c), row);
  if (!before) throw conflict("Fireblocks proposal is unavailable; cancellation is unconfirmed");
  let acknowledged = false;
  if (isFireblocksProposalCancellable(before.status)) {
    try {
      acknowledged = await canceller.cancel(before.id);
    } catch (error) {
      getLogger().warn(
        { proposalId: row.id, ...describeError(error) },
        "fireblocks_proposal_cancellation_unknown"
      );
    }
    try {
      await readFireblocksSigningProposal(c.env, proposals(c), row);
    } catch (error) {
      getLogger().warn(
        { proposalId: row.id, ...describeError(error) },
        "fireblocks_proposal_status_unavailable"
      );
    }
  }
  return { acknowledged, proposal: signingSummary(await proposals(c).require(row.id)) };
}

export const fireblocksProposals = new Hono<{ Bindings: Env }>();
fireblocksProposals.get(
  "/proposals",
  requireAction("wallets.configure"),
  validateQuery(listFireblocksProposalsSchema),
  async (c) => {
    const query = listFireblocksProposalsSchema.parse(c.req.query());
    await authorizeWallet(c, query.walletId);
    c.header("Cache-Control", "no-store");
    if (query.kind === "signing") {
      const rows = await proposals(c).list(query.walletId, query.offset);
      // Bounded provider reads, sequential here to respect workspace rate limits; leases share concurrent reads.
      const items: FireblocksProposalSummary[] = [];
      for (const row of rows.slice(0, 20)) items.push(signingSummary(await refreshSigning(c, row)));
      return success(c, { proposals: items, hasMore: rows.length > 20 });
    }
    const ids = await getDb(c.env).queryMany<{ id: string }>(
      `SELECT id FROM payment_transfers WHERE organization_id = ? AND project_id = ? AND custody_wallet_id = ?
     AND jsonb_exists(provider_data::jsonb, 'fireblocksTransfer') ORDER BY created_at DESC, id DESC LIMIT 21 OFFSET ?`,
      [scope(c).organizationId, scope(c).projectId, query.walletId, query.offset]
    );
    const repo = getPaymentsRepository(c);
    const items: FireblocksProposalSummary[] = [];
    for (const { id } of ids.slice(0, 20)) {
      const row = await repo.getTransferById({ ...scope(c), transferId: id });
      if (row)
        items.push(
          transferSummary(await refreshFireblocksTransfer(c.env, requestProposalLedger(c), row))
        );
    }
    return success(c, { proposals: items, hasMore: ids.length > 20 });
  }
);
fireblocksProposals.post(
  "/proposals/:kind/:proposalId/cancel",
  requireAction("wallets.configure"),
  validateParams(cancelFireblocksProposalParams),
  authorize(authorizeCancellation),
  idempotent({ key: "required", serverErrors: "store" }),
  async (c) => {
    const authorized = getAuthorized<Cancellation>(c);
    const audit = new AuditService(getDb(c.env));
    const intent = await audit.beginCritical(c, {
      ...scope(c),
      action: "revoke",
      resourceType: "signing_request",
      resourceId: authorized.row.id,
      metadata: { event: "fireblocks_manual_cancellation_requested", kind: authorized.kind },
    });
    const result =
      authorized.kind === "signing"
        ? await cancelSigning(c, authorized.row)
        : await cancelPendingFireblocksTransfer(
            c.env,
            requestProposalLedger(c, audit),
            authorized.row
          ).then(({ acknowledged, row }) => ({ acknowledged, proposal: transferSummary(row) }));
    await audit.completeCritical(c, intent, {
      metadata: {
        event: "fireblocks_manual_cancellation_result",
        acknowledged: result.acknowledged,
        status: result.proposal.status,
      },
    });
    return success(c, result);
  }
);
