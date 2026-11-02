import { currentClusterScope } from "@sdp/rpc/scope";
import type { EarnProviderActionKind } from "@sdp/types/earn-provider-orders";
import { Hono } from "hono";
import { getDb } from "@/db/client";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  createEarnProviderActionsRepository,
  type EarnProviderActionClaim,
  type EarnProviderActionRow,
} from "@/db/repositories/earn-provider-actions.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { internalError, notFound } from "@/lib/errors";
import { assertCallerWalletInScope } from "@/lib/money-admission";
import { success } from "@/lib/response";
import { authorize, getAuthorized } from "@/middleware/authorize";
import { getIdempotencyClaim, getIdempotencyRecordKey, idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import { type AppContext, requireEarnStrategyForCaller } from "@/routes/earn/context";
import { assertVaultDepositAdmissible } from "@/routes/earn/handlers/admission";
import { parseParams } from "@/routes/earn/handlers/shared";
import {
  listReadableEarnVaultWallets,
  resolveEarnVaultCustodyWallet,
} from "@/routes/earn/handlers/vault";
import { type AuditLogEntry, AuditService } from "@/services/audit.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import {
  claimProviderAction,
  executeClaimedProviderAction,
  readProviderAction,
  submitExternalProviderAction,
} from "@/services/earn/provider-actions.service";
import type { Env } from "@/types/env";
import {
  custodyCancellationSchema,
  custodyPreparationSchema,
  externalCancellationSchema,
  externalPreparationSchema,
  providerActionParamsSchema,
  providerActionSubmitSchema,
} from "./schemas";

type Target = Omit<
  EarnProviderActionClaim,
  "request_id" | "fingerprint" | "created_by" | "initiated_by_key_id"
> & { admit?: () => Promise<void> };
async function custodyOwner(c: AppContext, walletId: string) {
  const auth = getAuth(c),
    projectId = requireProjectId(c);
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: auth.organizationId,
    projectId,
  });
  const wallet = resolveEarnVaultCustodyWallet(wallets, walletId);
  assertCallerWalletInScope(auth, wallet.id);
  return wallet.publicKey;
}
function base(c: AppContext) {
  return {
    organization_id: getAuth(c).organizationId,
    project_id: requireProjectId(c),
    environment: currentClusterScope().environment,
  };
}
async function preparationTarget(
  c: AppContext,
  body: { strategyId: string; custodyWalletId?: string; ownerAddress?: string; feePayer?: string },
  external: boolean
): Promise<Target> {
  const { strategy } = await requireEarnStrategyForCaller(c, body.strategyId);
  let owner: string;
  if (external) {
    if (body.ownerAddress === undefined)
      throw internalError("External preparation needs its owner");
    owner = body.ownerAddress;
  } else {
    if (body.custodyWalletId === undefined)
      throw internalError("Preparation needs its custody wallet");
    owner = await custodyOwner(c, body.custodyWalletId);
  }
  if (
    strategy.share_mint === null ||
    strategy.deposit_mints.length !== 1 ||
    strategy.deposit_mints[0] === undefined
  )
    throw notFound("Preparatory vault asset identity");
  return {
    ...base(c),
    provider: strategy.provider,
    action: "preparation",
    parent_movement_id: null,
    custody_wallet_id: body.custodyWalletId === undefined ? null : body.custodyWalletId,
    owner_address: owner,
    vault_address: strategy.provider_reference,
    token_mint: strategy.deposit_mints[0],
    share_mint: strategy.share_mint,
    fee_payer: body.feePayer === undefined || body.feePayer === owner ? null : body.feePayer,
    admit: async () => {
      await assertVaultDepositAdmissible(c, strategy);
    },
  };
}
async function cancellationTarget(
  c: AppContext,
  body: { movementId: string; feePayer?: string },
  external: boolean
): Promise<Target> {
  const scoped = base(c),
    ledger = createPostgresEarnMovementsRepository(getDb(c.env));
  const parent = await ledger.getMovementById({
    organizationId: scoped.organization_id,
    movementId: body.movementId,
  });
  if (
    !parent ||
    parent.environment !== scoped.environment ||
    parent.project_id !== scoped.project_id ||
    parent.execution_model !== "vault_direct" ||
    parent.direction !== "withdrawal"
  )
    throw notFound("Earn provider order");
  const position = await ledger.getPositionById({
    organizationId: scoped.organization_id,
    environment: scoped.environment,
    positionId: parent.position_id,
  });
  if (
    !position?.token_mint ||
    !position.share_mint ||
    !parent.vault_address ||
    external !== (parent.custody_wallet_id === null)
  )
    throw notFound("Earn provider order");
  let owner: string;
  if (external) {
    if (!parent.owner_address) throw notFound("Earn provider order");
    owner = parent.owner_address;
  } else {
    if (parent.custody_wallet_id === null) throw notFound("Earn provider order");
    owner = await custodyOwner(c, parent.custody_wallet_id);
  }
  return {
    ...scoped,
    provider: parent.provider,
    action: "cancellation",
    parent_movement_id: parent.id,
    custody_wallet_id: parent.custody_wallet_id,
    owner_address: owner,
    vault_address: parent.vault_address,
    token_mint: position.token_mint,
    share_mint: position.share_mint,
    fee_payer: body.feePayer === undefined || body.feePayer === owner ? null : body.feePayer,
  };
}
async function requireScopedAction(
  c: AppContext,
  actionId: string
): Promise<EarnProviderActionRow> {
  const auth = getAuth(c),
    projectId = requireProjectId(c);
  const row = await createEarnProviderActionsRepository(getDb(c.env)).get({
    organizationId: auth.organizationId,
    projectId,
    actionId,
  });
  if (!row || row.environment !== currentClusterScope().environment)
    throw notFound("Earn provider action");
  if (row.custody_wallet_id !== null) {
    const wallets = await listReadableEarnVaultWallets(c, auth, projectId);
    if (!wallets.some((w) => w.id === row.custody_wallet_id))
      throw notFound("Earn provider action");
  }
  return row;
}
export function providerActionWire(row: EarnProviderActionRow) {
  return {
    actionId: row.id,
    action: row.action,
    status: row.status,
    provider: row.provider,
    providerReference: row.vault_address,
    ownerAddress: row.owner_address,
    feePayer: row.fee_payer,
    parentMovementId: row.parent_movement_id,
    signature: row.signature,
    deliverySignature: row.delivery_signature,
    lastValidBlockHeight: row.last_valid_block_height,
    error: row.error,
    createdAt: row.created_at,
    transaction: row.status === "prepared" ? row.unsigned_transaction : null,
  };
}
/** The audit record for a claimed action, written with its claim row. */
function claimAuditEntry(row: EarnProviderActionRow): AuditLogEntry {
  return {
    organizationId: row.organization_id,
    userId: row.created_by === null ? undefined : row.created_by,
    apiKeyId: row.initiated_by_key_id === null ? undefined : row.initiated_by_key_id,
    action: row.action === "preparation" ? "create" : "withdraw_cancel",
    resourceType: "earn_provider_action",
    resourceId: row.id,
    metadata: {
      provider: row.provider,
      status: row.status,
      parentMovementId: row.parent_movement_id,
      signature: row.signature,
    },
  };
}
async function create(c: AppContext) {
  const { admit, ...target } = getAuthorized<Target>(c),
    auth = getAuth(c);
  const claimed = getIdempotencyClaim(c),
    key = getIdempotencyRecordKey(c);
  if (!claimed || !key) throw internalError("Provider actions require an idempotency claim");
  // The audit record commits with the action's claim row, and an audit failure
  // escapes: an accepted command never commits unaudited. Only a claim this
  // request owns is audited; a replay answers from recorded rows. The provider
  // tail (builds, signatures, RPC) runs after that transaction returns the
  // ledger's writer lock.
  const claim = await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const result = await claimProviderAction(
      c.env,
      {
        ...target,
        request_id: key,
        fingerprint: claimed.fingerprint,
        created_by: auth.userId === undefined ? null : auth.userId,
        initiated_by_key_id: auth.apiKeyId === undefined ? null : auth.apiKeyId,
      },
      tx
    );
    return { entry: result.owned ? claimAuditEntry(result.row) : null, result };
  });
  const row = await executeClaimedProviderAction(c.env, claim, admit);
  return success(c, { action: providerActionWire(row) });
}
function authorizeSubmission(kind: EarnProviderActionKind) {
  return authorize(async (c, { body }) => {
    const input = providerActionSubmitSchema.parse(body);
    const row = await requireScopedAction(c, input.actionId);
    if (row.custody_wallet_id !== null || row.action !== kind)
      throw notFound("External provider action");
    return { row, signedTransaction: input.signedTransaction };
  });
}
async function submit(c: AppContext) {
  const { row, signedTransaction } = getAuthorized<{
    row: EarnProviderActionRow;
    signedTransaction: string;
  }>(c);
  return success(c, {
    action: providerActionWire(await submitExternalProviderAction(c.env, row, signedTransaction)),
  });
}

export const providerActions = new Hono<{ Bindings: Env }>();
providerActions.post(
  "/preparations",
  requireAction("earn.execute"),
  validateBody(custodyPreparationSchema),
  authorize((c, { body }) => preparationTarget(c, custodyPreparationSchema.parse(body), false)),
  idempotent({ key: "required", serverErrors: "rerun" }),
  meteredQuota({ name: "earn-provider-preparation", actorMax: 30, orgMax: 120 }),
  create
);
providerActions.post(
  "/cancellations",
  requireAction("earn.manage"),
  validateBody(custodyCancellationSchema),
  authorize((c, { body }) => cancellationTarget(c, custodyCancellationSchema.parse(body), false)),
  idempotent({ key: "required", serverErrors: "rerun" }),
  create
);
providerActions.post(
  "/external/preparation-transactions",
  requireAction("earn.execute"),
  validateBody(externalPreparationSchema),
  authorize((c, { body }) => preparationTarget(c, externalPreparationSchema.parse(body), true)),
  idempotent({ key: "required", serverErrors: "rerun" }),
  meteredQuota({ name: "earn-provider-preparation", actorMax: 30, orgMax: 120 }),
  create
);
providerActions.post(
  "/external/cancellation-transactions",
  requireAction("earn.manage"),
  validateBody(externalCancellationSchema),
  authorize((c, { body }) => cancellationTarget(c, externalCancellationSchema.parse(body), true)),
  idempotent({ key: "required", serverErrors: "rerun" }),
  create
);
providerActions.post(
  "/external/preparations",
  requireAction("earn.execute"),
  validateBody(providerActionSubmitSchema),
  authorizeSubmission("preparation"),
  idempotent({ key: "required", serverErrors: "rerun" }),
  meteredQuota({ name: "earn-provider-action-submit", actorMax: 30, orgMax: 120 }),
  submit
);
providerActions.post(
  "/external/cancellations",
  requireAction("earn.manage"),
  validateBody(providerActionSubmitSchema),
  authorizeSubmission("cancellation"),
  idempotent({ key: "required", serverErrors: "rerun" }),
  submit
);
providerActions.get(
  "/:actionId",
  requireAction("earn.read"),
  meteredQuota({ name: "earn-chain-read", actorMax: 30, orgMax: 120 }),
  async (c) => {
    const { actionId } = parseParams(c, providerActionParamsSchema);
    return success(c, {
      action: providerActionWire(
        await readProviderAction(c.env, await requireScopedAction(c, actionId))
      ),
    });
  }
);
