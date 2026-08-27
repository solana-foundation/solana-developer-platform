import {
  mapHeliusRingsOperationSummaryRow,
  mapHeliusRingsWalletRow,
  mapHeliusRingsZoneRow,
} from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveScope, resolveWallet } from "@/routes/payments/wallets";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import {
  type AppContext,
  getHeliusRingsOperationRepository,
  getHeliusRingsService,
  getHeliusRingsWalletRepository,
  getHeliusRingsZoneRepository,
  requireParam,
  withRingsErrors,
} from "./context";
import {
  createRingsWalletSchema,
  createRingsZoneSchema,
  listLimitSchema,
  prepareRingsOperationSchema,
  retryRingsOperationSchema,
} from "./schemas";

function tenantOf(c: AppContext) {
  const auth = getAuth(c);
  return {
    auth,
    tenant: { organizationId: auth.organizationId, projectId: requireProjectId(c) },
  };
}

// --- health -----------------------------------------------------------------

/** GET /health — probe the gateway and return the per-component status board. */
export async function getRingsHealth(c: AppContext) {
  const { tenant } = tenantOf(c);
  const service = getHeliusRingsService(c, tenant);
  return success(c, { health: await service.probeHealth() });
}

// --- wallets ----------------------------------------------------------------

/**
 * POST /wallets — bind a rings wallet to an SDP custody wallet and provision
 * its shielded identity. A gateway that refuses answers 503 carrying its own
 * reason and the wallet stays `pending`; the workspace renders that reason
 * verbatim rather than substituting a notice of its own.
 */
export async function createRingsWallet(c: AppContext) {
  const parsed = createRingsWalletSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { tenant } = tenantOf(c);
  const scope = await resolveScope(c);
  const custodyWallet = resolveWallet(scope.wallets, parsed.data.walletId);

  const service = getHeliusRingsService(c, tenant);
  const wallet = await withRingsErrors(() =>
    service.provisionPrivateWallet({
      sdpWalletId: custodyWallet.walletId,
      sdpAddress: custodyWallet.publicKey,
      name: parsed.data.name,
    })
  );
  return success(c, { wallet }, 201);
}

/** GET /wallets — the project's rings wallets, newest first. */
export async function listRingsWallets(c: AppContext) {
  const { tenant } = tenantOf(c);
  const limit = listLimitSchema.parse(c.req.query("limit"));
  const rows = await getHeliusRingsWalletRepository(c).listWallets({ ...tenant, limit });
  return success(c, { wallets: rows.map(mapHeliusRingsWalletRow) });
}

/** GET /wallets/:walletId */
export async function getRingsWallet(c: AppContext) {
  const { tenant } = tenantOf(c);
  const row = await getHeliusRingsWalletRepository(c).getWalletById({
    ...tenant,
    id: requireParam(c, "walletId"),
  });
  if (!row) throw notFound("rings wallet");
  return success(c, { wallet: mapHeliusRingsWalletRow(row) });
}

/**
 * POST /wallets/:walletId/sync — read shielded balances from Photon.
 *
 * The owner is the public key of the custody wallet backing this rings wallet,
 * resolved from the caller's scope the same way the operation handlers resolve
 * it. Nothing is persisted about the owner: the identity is re-derived from it
 * on every call and checked against the stored shielded address, so a wrong
 * owner fails closed rather than answering with someone else's balances.
 *
 * Amounts stay decimal strings all the way out. They are uint64 on the wire
 * and a JSON number would silently round anything past 2^53.
 */
export async function syncRingsWallet(c: AppContext) {
  const { tenant } = tenantOf(c);
  const walletId = requireParam(c, "walletId");
  const ringsWallet = await getHeliusRingsWalletRepository(c).getWalletById({
    ...tenant,
    id: walletId,
  });
  if (!ringsWallet) throw notFound("rings wallet");

  const scope = await resolveScope(c);
  const custodyWallet = scope.wallets.find((entry) => entry.walletId === ringsWallet.sdp_wallet_id);

  const service = getHeliusRingsService(c, tenant);
  const synced = await withRingsErrors(() =>
    service.syncWallet(walletId, custodyWallet?.publicKey ?? null)
  );
  return success(c, {
    balances: synced.balances,
    degraded: synced.degraded,
    observedAt: synced.observedAt,
  });
}

/**
 * GET /wallets/:walletId/identity — what the Rings registry publishes for this
 * wallet's owner, and whether it is the identity this tenant derives.
 *
 * A GET behind the read permission, unlike `/sync`. A sync advances the
 * wallet's recorded observation point and so earns the write permission its
 * side effect deserves; this advances nothing and writes nothing, so it does
 * not. The owner is resolved from the caller's scope exactly as the sync
 * handler resolves it.
 *
 * Answers for a wallet with no shielded address at all — that is the case an
 * operator reaches for it in, having hit a provisioning conflict with nothing
 * recorded to compare against.
 */
export async function getRingsWalletIdentity(c: AppContext) {
  const { tenant } = tenantOf(c);
  const walletId = requireParam(c, "walletId");
  const ringsWallet = await getHeliusRingsWalletRepository(c).getWalletById({
    ...tenant,
    id: walletId,
  });
  if (!ringsWallet) throw notFound("rings wallet");

  const scope = await resolveScope(c);
  const custodyWallet = scope.wallets.find((entry) => entry.walletId === ringsWallet.sdp_wallet_id);

  const service = getHeliusRingsService(c, tenant);
  const identity = await withRingsErrors(() =>
    service.readWalletIdentity(walletId, custodyWallet?.publicKey ?? null)
  );
  return success(c, { identity });
}

// --- zones ------------------------------------------------------------------

/** GET /wallets/:walletId/zones — SDP-owned metadata; fully functional today. */
export async function listRingsZones(c: AppContext) {
  const { tenant } = tenantOf(c);
  const walletId = requireParam(c, "walletId");
  const wallet = await getHeliusRingsWalletRepository(c).getWalletById({ ...tenant, id: walletId });
  if (!wallet) throw notFound("rings wallet");
  const zones = await getHeliusRingsZoneRepository(c).listZonesByWallet({ walletId });
  return success(c, { zones: zones.map(mapHeliusRingsZoneRow) });
}

/** POST /wallets/:walletId/zones — idempotent per (wallet, name). */
export async function createRingsZone(c: AppContext) {
  const parsed = createRingsZoneSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { tenant } = tenantOf(c);
  const walletId = requireParam(c, "walletId");
  const wallet = await getHeliusRingsWalletRepository(c).getWalletById({ ...tenant, id: walletId });
  if (!wallet) throw notFound("rings wallet");

  const zone = await getHeliusRingsZoneRepository(c).createZone({
    walletId,
    name: parsed.data.name,
    kind: parsed.data.kind,
  });
  if (!zone) throw badRequest("zone could not be created");
  return success(c, { zone: mapHeliusRingsZoneRow(zone) }, 201);
}

// --- operations ---------------------------------------------------------------

/** POST /operations — reserve the intent and advance through policy. */
export async function prepareRingsOperation(c: AppContext) {
  const parsed = prepareRingsOperationSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { auth, tenant } = tenantOf(c);
  const ringsWallet = await getHeliusRingsWalletRepository(c).getWalletById({
    ...tenant,
    id: parsed.data.walletId,
  });
  if (!ringsWallet) throw notFound("rings wallet");

  // The policy envelope wants the custody wallet backing the rings wallet;
  // absence is tolerated (the envelope's wallet id still scopes the policy).
  const scope = await resolveScope(c);
  const custodyWallet = scope.wallets.find((entry) => entry.walletId === ringsWallet.sdp_wallet_id);

  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.prepareOperation(parsed.data, {
      apiKeyId: auth.apiKeyId,
      actor: walletOperationActorFromAuth(auth),
      custodyWalletId: custodyWallet?.id ?? null,
      owner: custodyWallet?.publicKey ?? null,
    })
  );
  return success(c, { operation }, 201);
}

/** GET /operations — the project's activity feed, newest first. */
export async function listRingsOperations(c: AppContext) {
  const { tenant } = tenantOf(c);
  const limit = listLimitSchema.parse(c.req.query("limit"));
  const rows = await getHeliusRingsOperationRepository(c).listOperationsByProject({
    ...tenant,
    limit,
  });
  return success(c, { operations: rows.map(mapHeliusRingsOperationSummaryRow) });
}

/** GET /operations/:operationId — full detail with the event timeline. */
export async function getRingsOperation(c: AppContext) {
  const { tenant } = tenantOf(c);
  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.getOperationWithEvents(requireParam(c, "operationId"))
  );
  return success(c, { operation });
}

/**
 * POST /operations/:operationId/execute — advance a waiting operation. The
 * approval verdict is read server-side from the approval request; the request
 * carries no body worth trusting.
 */
export async function executeRingsOperation(c: AppContext) {
  const { tenant } = tenantOf(c);
  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.executeOperation(requireParam(c, "operationId"))
  );
  return success(c, { operation });
}

/**
 * POST /operations/:operationId/retry — file a linked retry of a failed op.
 * The retry runs the full prepare-through-policy path, so it re-earns its
 * policy verdict under the current caller's context.
 */
export async function retryRingsOperation(c: AppContext) {
  const parsed = retryRingsOperationSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { auth, tenant } = tenantOf(c);
  const failedId = requireParam(c, "operationId");
  const failed = await getHeliusRingsOperationRepository(c).getOperationById({
    ...tenant,
    id: failedId,
  });
  if (!failed) throw notFound("rings operation");

  const [ringsWallet, scope] = await Promise.all([
    getHeliusRingsWalletRepository(c).getWalletById({
      ...tenant,
      id: failed.wallet_id,
    }),
    resolveScope(c),
  ]);
  const custodyWallet = ringsWallet
    ? scope.wallets.find((entry) => entry.walletId === ringsWallet.sdp_wallet_id)
    : undefined;

  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.retryOperation(failedId, parsed.data.clientNonce, {
      apiKeyId: auth.apiKeyId,
      actor: walletOperationActorFromAuth(auth),
      custodyWalletId: custodyWallet?.id ?? null,
      owner: custodyWallet?.publicKey ?? null,
    })
  );
  return success(c, { operation }, 201);
}
