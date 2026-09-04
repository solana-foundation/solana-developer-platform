import type { AssetBalance } from "@sdp/helius-rings";
import type { CustodyWalletTokenBalance } from "@sdp/types";
import {
  type HeliusRingsWalletRow,
  mapHeliusRingsOperationSummaryRow,
  mapHeliusRingsWalletRow,
  mapHeliusRingsZoneRow,
} from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveScope, resolveWallet } from "@/routes/payments/wallets";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { attachUsdValuesToBalances } from "@/services/helius-das.service";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";
import {
  type AppContext,
  allowedRingsWalletIds,
  getHeliusRingsOperationRepository,
  getHeliusRingsService,
  getHeliusRingsWalletRepository,
  getHeliusRingsZoneRepository,
  requireParam,
  requireRingsOperation,
  requireRingsWallet,
  withRingsErrors,
} from "./context";
import {
  createProjectRingSchema,
  createRingsWalletSchema,
  createRingsZoneSchema,
  listLimitSchema,
  prepareRingsOperationSchema,
  retryRingsOperationSchema,
  voidRingsOperationSchema,
} from "./schemas";

function tenantOf(c: AppContext) {
  const auth = getAuth(c);
  return {
    auth,
    tenant: { organizationId: auth.organizationId, projectId: requireProjectId(c) },
  };
}

function policyCustodyWalletId(wallet: HeliusRingsWalletRow): string {
  if (wallet.custody_wallet_id === null) {
    throw conflict("Rings wallet is missing its custody wallet linkage");
  }
  return wallet.custody_wallet_id;
}

// --- health -----------------------------------------------------------------

/** GET /health — probe the gateway and return the per-component status board. */
export async function getRingsHealth(c: AppContext) {
  const { tenant } = tenantOf(c);
  const service = getHeliusRingsService(c, tenant);
  return success(c, { health: await service.probeHealth() });
}

// --- project rings ----------------------------------------------------------

/** GET /rings — the project's custom rings, oldest first; empty while it only uses the default pool. */
export async function listRingsProjectRings(c: AppContext) {
  const { tenant } = tenantOf(c);
  const service = getHeliusRingsService(c, tenant);
  const rings = await withRingsErrors(() => service.listProjectRings());
  return success(c, { rings });
}

/**
 * POST /rings — record a named custom ring's program id and complete bring-up
 * through the gateway. Re-submitting the same name and id resumes a failed
 * bring-up. Once the ring is active, operations can target it (`ring:
 * "<name>"`); default-ring operations and sync are never blocked by it.
 */
export async function createRingsProjectRing(c: AppContext) {
  const parsed = createProjectRingSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { tenant } = tenantOf(c);
  const service = getHeliusRingsService(c, tenant);
  const ring = await withRingsErrors(() => service.createProjectRing(parsed.data));
  return success(c, { ring }, 201);
}

// --- wallets ----------------------------------------------------------------

/** POST /wallets — bind a Rings wallet to an SDP custody wallet and provision its identity. */
export async function createRingsWallet(c: AppContext) {
  const parsed = createRingsWalletSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { tenant } = tenantOf(c);
  // The custody wallet named in the body, not a rings wallet that exists yet —
  // so the scope check goes straight to the provider id the key is bound to.
  assertApiKeyWalletAccess(getAuth(c), parsed.data.walletId, ["payments:write"]);

  const scope = await resolveScope(c);
  const custodyWallet = resolveWallet(scope.wallets, parsed.data.walletId);

  const service = getHeliusRingsService(c, tenant);
  const wallet = await withRingsErrors(() =>
    service.provisionPrivateWallet({
      sdpWalletId: custodyWallet.walletId,
      sdpAddress: custodyWallet.publicKey,
      name: parsed.data.name,
      // The immutable row id, so later signing resolves this same wallet even
      // if the custody provider reissues its own identifier for it.
      custodyWalletId: custodyWallet.id,
    })
  );
  return success(c, { wallet }, 201);
}

/**
 * GET /wallets — the project's rings wallets, newest first.
 *
 * Filtered rather than refused: a wallet-scoped key asking for its wallets
 * wants the ones it holds, not a 403. The repository applies the scope before
 * the list limit so unauthorized rows cannot consume the page.
 */
export async function listRingsWallets(c: AppContext) {
  const { tenant } = tenantOf(c);
  const limit = listLimitSchema.parse(c.req.query("limit"));
  const allowed = allowedRingsWalletIds(c, ["payments:read"]);
  const rows = await getHeliusRingsWalletRepository(c).listWallets({
    ...tenant,
    limit,
    ...(allowed ? { sdpWalletIds: [...allowed] } : {}),
  });
  return success(c, { wallets: rows.map(mapHeliusRingsWalletRow) });
}

/** GET /wallets/:walletId */
export async function getRingsWallet(c: AppContext) {
  const { tenant } = tenantOf(c);
  const row = await requireRingsWallet(c, tenant, requireParam(c, "walletId"), ["payments:read"]);
  return success(c, { wallet: mapHeliusRingsWalletRow(row) });
}

/**
 * POST /wallets/:walletId/sync — read the wallet's shielded state from Photon.
 *
 * Always a full sync, and the balances it returns are only complete when
 * `report.degraded` is false; the caller is expected to surface that rather
 * than round it away.
 */
export async function syncRingsWallet(c: AppContext) {
  const { tenant } = tenantOf(c);
  await requireRingsWallet(c, tenant, requireParam(c, "walletId"), ["payments:write"]);
  const service = getHeliusRingsService(c, tenant);
  const result = await withRingsErrors(() => service.syncWallet(requireParam(c, "walletId")));
  const priced = await priceRingsBalances(c.env, result.balances);
  return success(c, {
    balances: priced.balances,
    totalUsd: priced.totalUsd,
    degraded: result.report.degraded,
    observedAt: result.observedAt,
  });
}

// Enrich Rings balances with USD via the shared pricing path used by custody.
// Fails soft: a pricing outage returns unpriced balances (totalUsd = null), so
// the shielded balance itself is still visible.
async function priceRingsBalances(
  env: Env,
  balances: readonly AssetBalance[]
): Promise<{
  balances: (AssetBalance & { usdPrice?: number; usdValue?: number })[];
  totalUsd: number | null;
}> {
  if (balances.length === 0) return { balances: [], totalUsd: 0 };

  const asCustody: CustodyWalletTokenBalance[] = balances.map((balance) => {
    const decimals = balance.decimals ?? 0;
    return {
      token: balance.symbol,
      mint: balance.mint,
      amount: balance.amountRaw,
      uiAmount: decimalFromBaseUnits(balance.amountRaw, decimals),
      decimals,
    };
  });

  let priced: CustodyWalletTokenBalance[];
  try {
    priced = await attachUsdValuesToBalances(env, asCustody);
  } catch {
    return { balances: balances.map((balance) => ({ ...balance })), totalUsd: null };
  }

  const enriched = balances.map((balance, index) => {
    const row = priced[index];
    return {
      ...balance,
      ...(typeof row?.usdPrice === "number" ? { usdPrice: row.usdPrice } : {}),
      ...(typeof row?.usdValue === "number" ? { usdValue: row.usdValue } : {}),
    };
  });

  const anyPriced = enriched.some((balance) => typeof balance.usdValue === "number");
  const totalUsd = anyPriced
    ? Number(enriched.reduce((sum, balance) => sum + (balance.usdValue ?? 0), 0).toFixed(2))
    : null;
  return { balances: enriched, totalUsd };
}

/**
 * BigInt-safe base10 conversion — bare Number(amountRaw) rounds past 2^53. Mirrors
 * the client's readShieldedAmount so the string produced here parses the same on
 * the receiving side.
 */
function decimalFromBaseUnits(amountRaw: string, decimals: number): string {
  if (!/^\d+$/.test(amountRaw)) return "0";
  if (decimals === 0) return amountRaw;
  const padded = amountRaw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? whole : `${whole}.${trimmed}`;
}

/** GET /wallets/:walletId/identity */
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

/** POST /operations/:operationId/void — operator confirms a signed failure never landed. */
export async function voidRingsOperation(c: AppContext) {
  const parsed = voidRingsOperationSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { auth, tenant } = tenantOf(c);
  await requireRingsOperation(c, tenant, requireParam(c, "operationId"), ["payments:write"]);
  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.voidOperation(requireParam(c, "operationId"), parsed.data.signature, {
      apiKeyId: auth.apiKeyId,
      actor: walletOperationActorFromAuth(auth),
    })
  );
  return success(c, { operation });
}

/**
 * POST /operations/:operationId/recheck — ask the indexer about a signed
 * failure again.
 *
 * Observation, not assertion: it can only ever complete a row the indexer has
 * caught up on, and it never concludes absence. That makes it the safe thing
 * to try before a void, which asserts the opposite and cannot be undone. It
 * carries no body and is idempotent, so pressing it twice costs one extra read.
 */
export async function recheckRingsOperation(c: AppContext) {
  const { tenant } = tenantOf(c);
  await requireRingsOperation(c, tenant, requireParam(c, "operationId"), ["payments:write"]);
  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.completeIfIndexed(requireParam(c, "operationId"))
  );
  return success(c, { operation });
}

// --- zones ------------------------------------------------------------------

/** GET /wallets/:walletId/zones — SDP-owned metadata; fully functional today. */
export async function listRingsZones(c: AppContext) {
  const { tenant } = tenantOf(c);
  const walletId = requireParam(c, "walletId");
  await requireRingsWallet(c, tenant, walletId, ["payments:read"]);
  const zones = await getHeliusRingsZoneRepository(c).listZonesByWallet({ walletId });
  return success(c, { zones: zones.map(mapHeliusRingsZoneRow) });
}

/** POST /wallets/:walletId/zones — idempotent per (wallet, name). */
export async function createRingsZone(c: AppContext) {
  const parsed = createRingsZoneSchema.safeParse(await c.req.json());
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body");

  const { tenant } = tenantOf(c);
  const walletId = requireParam(c, "walletId");
  await requireRingsWallet(c, tenant, walletId, ["payments:write"]);

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
  const ringsWallet = await requireRingsWallet(c, tenant, parsed.data.walletId, ["payments:write"]);
  const custodyWalletId = policyCustodyWalletId(ringsWallet);

  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.prepareOperation(parsed.data, {
      apiKeyId: auth.apiKeyId,
      actor: walletOperationActorFromAuth(auth),
      custodyWalletId,
    })
  );
  return success(c, { operation }, 201);
}

/**
 * GET /operations — the project's activity feed, newest first.
 *
 * Filtered to the wallets the key may read. Operations name their wallet by
 * rings id, so the visible set is resolved through the wallet rows rather than
 * assumed from the operation.
 */
export async function listRingsOperations(c: AppContext) {
  const { tenant } = tenantOf(c);
  const limit = listLimitSchema.parse(c.req.query("limit"));
  const allowed = allowedRingsWalletIds(c, ["payments:read"]);

  const walletIds = allowed
    ? await getHeliusRingsWalletRepository(c).listWalletIdsBySdpWalletIds({
        ...tenant,
        sdpWalletIds: [...allowed],
      })
    : undefined;
  const rows = await getHeliusRingsOperationRepository(c).listOperationsByProject({
    ...tenant,
    limit,
    ...(walletIds === undefined ? {} : { walletIds }),
  });
  return success(c, {
    operations: rows.map(mapHeliusRingsOperationSummaryRow),
  });
}

/** GET /operations/:operationId — full detail with the event timeline. */
export async function getRingsOperation(c: AppContext) {
  const { tenant } = tenantOf(c);
  await requireRingsOperation(c, tenant, requireParam(c, "operationId"), ["payments:read"]);
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
  await requireRingsOperation(c, tenant, requireParam(c, "operationId"), ["payments:write"]);
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
  const failed = await requireRingsOperation(c, tenant, failedId, ["payments:write"]);

  const ringsWallet = await getHeliusRingsWalletRepository(c).getWalletById({
    ...tenant,
    id: failed.wallet_id,
  });
  if (!ringsWallet) {
    throw internalError("rings operation references a missing Rings wallet");
  }
  const custodyWalletId = policyCustodyWalletId(ringsWallet);

  const service = getHeliusRingsService(c, tenant);
  const operation = await withRingsErrors(() =>
    service.retryOperation(failedId, parsed.data.clientNonce, {
      apiKeyId: auth.apiKeyId,
      actor: walletOperationActorFromAuth(auth),
      custodyWalletId,
    })
  );
  return success(c, { operation }, 201);
}
