import { isDecimalString } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import { earnDepositStyle, isVaultDirectDepositEnabled } from "@sdp/types/provider-access";
import { z } from "zod";
import { getDb } from "@/db";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
import { requireProjectId } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  walletNotFound,
} from "@/lib/errors";
import { success } from "@/lib/response";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import { resolveScope } from "@/routes/payments/wallets";
import { getLogger } from "@/runtime/logger";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { earnClusterFor, resolveVaultDirectClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { depositIntoVault } from "@/services/earn/vault-deposit.service";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import {
  assertEarnProviderSurfaced,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "../context";
import { earnRuntime, getEarnRepository, resolveSdpEnvironment } from "../context";
import { earnVaultDepositSchema, earnVaultPositionsQuerySchema } from "../schemas";
import { assertStrategyDepositable } from "./admission";
import { parseQuery } from "./shared";

/**
 * POST /v1/earn/vault-deposits — open or add to a non-custodial vault position,
 * funded from an SDP custody wallet and signed by SDP.
 *
 * A separate collection from `/programs` on purpose. A "program" is the
 * CUSTODIAL model: SDP provisions a provider wallet and the customer funds its
 * address later, so create and fund are two steps with an address in between.
 * A vault position has no address and no gap — the deposit IS the creation. One
 * endpoint that meant both would have to explain which half happened when the
 * chain rejected the transfer.
 */
export async function createEarnVaultDeposit(c: AppContext) {
  const { body: parsedData, resolved } = getPolicyGateContext<
    EarnVaultDepositBody,
    EarnVaultDepositResolved
  >(c);
  const { strategy, wallet, auth, projectId, environment } = resolved;
  const tokenMint = strategy.deposit_mints[0];
  if (!tokenMint) {
    throw internalError(`Earn strategy ${strategy.id} has no deposit mint`);
  }
  const shareMint = strategy.share_mint;
  if (!shareMint) {
    throw internalError(`Earn strategy ${strategy.id} has no share mint`);
  }

  const result = await depositIntoVault(
    c.env,
    {
      organizationId: auth.organizationId,
      projectId,
      environment,
      provider: strategy.provider,
      providerReference: strategy.provider_reference,
      wallet,
      tokenMint,
      shareMint,
      label: strategy.name,
      amount: parsedData.amount,
      requestId: parsedData.requestId,
      minSharesOut: parsedData.minSharesOut,
      userId: auth.userId ?? null,
      apiKeyId: auth.apiKeyId ?? null,
    },
    {
      runIntentTransaction: (mutation) => runApprovedWalletOperationEffectTransaction(c, mutation),
    }
  );

  if (result.replayed && approvedWalletOperationId(c)) {
    // Sequential replays do not pass through the insert transaction, so fence
    // the approved operation before returning their durable outcome. A legacy
    // unsigned row must fail closed instead of becoming a completed approval.
    await beginApprovedWalletOperationEffect(c);
    if (!result.movement.signature) {
      throw conflict(
        "Approved vault deposit execution is incomplete and requires manual reconciliation"
      );
    }
  }

  return success(c, {
    positionId: result.position.id,
    movementId: result.movement.id,
    status: result.movement.status,
    signature: result.movement.signature,
    failureReason: result.movement.failure_reason,
    // Tells a retrying caller that its key was already used and NOTHING was
    // re-sent — distinct from a fresh success with the same shape.
    replayed: result.replayed,
    strategy: {
      id: strategy.id,
      name: strategy.name,
      provider: strategy.provider,
      providerReference: strategy.provider_reference,
      hostCluster: strategy.host_cluster,
    },
  });
}

type EarnVaultDepositBody = z.output<typeof earnVaultDepositSchema>;

interface EarnVaultDepositResolved {
  strategy: EarnStrategyRow;
  wallet: CustodyWallet;
  auth: Awaited<ReturnType<typeof resolveScope>>["auth"];
  projectId: string;
  environment: SdpEnvironment;
}

/**
 * Parse and resolve a vault deposit into its wallet-operation policy candidate.
 *
 * Everything the handler needs is resolved HERE, before the gate enforces, for
 * one reason: policy has to be decided from trusted, fully-resolved context —
 * the real custody wallet, the real amount, the real target — and it has to be
 * decided BEFORE `createOrgSigner` is reached. A gate that ran on the raw body
 * could be argued out of a denial by a caller who names a wallet it does not
 * hold; a gate that ran after resolution but inside the handler would already
 * have touched custody.
 */
export async function extractEarnVaultDepositPolicyCandidate(
  c: AppContext
): Promise<PolicyGateExtraction> {
  const body = await c.req.json().catch(() => null);
  const parsed = earnVaultDepositSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid vault deposit request", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const environment = resolveSdpEnvironment(c);
  const { auth, wallets } = await resolveScope(c);
  const projectId = requireProjectId(c);

  // ENVIRONMENT CAPABILITY, before anything else and before any lookup.
  //
  // SDP can move money INTO a vault and not back out: there is no vault
  // withdraw route, and the Active tab does not surface vault positions. Until
  // both land, opening a position with real funds is a one-way door, so
  // production is refused server-side. Entitlement cannot express this — it is
  // org-scoped, not environment-scoped — which is exactly why an entitled org
  // would otherwise reach mainnet. The dashboard hides the affordance from the
  // same constant, so the button and the route agree by construction.
  if (!isVaultDirectDepositEnabled(environment)) {
    throw new AppError(
      "FORBIDDEN",
      "Vault deposits are not available in production yet: SDP has no vault-withdraw path, " +
        "so a position opened here could not be exited through SDP."
    );
  }

  // SLIPPAGE FLOOR, required wherever real money moves.
  //
  // Kamino's pinned SDK selects the LEGACY deposit instruction when no
  // `minSharesOut` is given — there is no implicit floor, so a vault-state
  // change between signing and inclusion can mint materially fewer shares than
  // the caller reviewed. The dashboard does not yet quote one (that needs a
  // live rate with a displayed tolerance and an expiry), so requiring it
  // unconditionally today would break the only working flow.
  //
  // This is scoped to production deliberately, and it is NOT dead code: the
  // environment gate above closes production for a different reason (no exit
  // path), and whoever lifts that gate must not silently also ship
  // unprotected deposits. This check is what makes the floor a prerequisite of
  // that change rather than something to remember.
  if (environment === "production" && parsed.data.minSharesOut === undefined) {
    throw badRequest(
      "minSharesOut is required for a production vault deposit: without a floor the pinned " +
        "Kamino SDK builds the legacy deposit instruction, which accepts any number of shares."
    );
  }

  // Resolve the strategy first: the caller names a catalogue row, never a raw
  // vault address. That keeps the deposit target inside what SDP catalogues and
  // means the admission gates the sync applied still bound this path.
  const strategy = await getEarnRepository(c).getStrategyById(parsed.data.strategyId);
  if (!strategy || strategy.environment !== environment) {
    throw notFound("Earn strategy");
  }

  // Shape check before anything else: a custodial provider reaching this route
  // would silently skip its wallet-provisioning model.
  if (earnDepositStyle(strategy.provider) !== "vault_direct") {
    throw badRequest(
      `${strategy.provider} is a custodial provider; use POST /v1/earn/programs instead.`
    );
  }

  // MONEY-IN GATES, in the same order and with the same meaning as
  // `POST /programs` (see routes/earn/CLAUDE.md → "Gate asymmetry"). Opening a
  // vault position is a new commitment, so it takes all of:
  //
  //   surfacing   — "SDP does not offer this provider", which no per-org
  //                 override can lift, and which reads differently from
  //                 entitlement. Checked first so a caller is never pointed at
  //                 an activation door that does not exist.
  //   entitlement — the org's own override plus the environment's credentials.
  //   admission   — the catalogue row is `active` and its cluster is fundable
  //                 here. Shared with `POST /programs` rather than re-derived:
  //                 this path used to check neither, so a `paused` strategy —
  //                 an operator's deliberate stop during an exploit or depeg —
  //                 stayed fundable by id.
  //
  // Money-OUT must never inherit any of these (ADR 0002): un-offering a
  // provider closes the door in, never the door out.
  assertEarnProviderSurfaced(strategy.provider as never);
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    auth.organizationId,
    "earn",
    strategy.provider as never,
    environment === "sandbox"
  );
  assertStrategyDepositable(strategy, environment);

  // The wallet must be one SDP can sign for, and the binding must carry a WRITE
  // scope. `wallets:read` on a binding only proves the key may LOOK at the
  // wallet — a read-only-bound key was previously able to spend from it. Global
  // `wallets:read` is required at the router for the same reason payments does
  // it: for a key with NO bindings the per-wallet assertion is a no-op, so the
  // router permission is the only gate that key ever meets.
  // Resolve only the exposed custody row id. Provider wallet ids are unique
  // only within one custody configuration, and public keys may also repeat, so
  // neither is a safe identifier for this money-in route.
  const wallet = resolveEarnVaultCustodyWallet(wallets, parsed.data.custodyWalletId);
  assertBoundWalletIdentifierIsUnique(auth, wallets, wallet);
  assertApiKeyWalletAccess(auth, wallet.walletId, ["earn:write"]);

  const resolved: EarnVaultDepositResolved = {
    strategy,
    wallet,
    auth,
    projectId,
    environment,
  };

  return {
    candidate: {
      organizationId: auth.organizationId,
      projectId,
      custodyWalletId: wallet.id,
      walletId: wallet.walletId,
      apiKeyId: auth.apiKeyId ?? null,
      actor: walletOperationActorFromAuth(auth),
      source: "earn_vault_deposit",
      // `program`, not `payment`: this is an interaction with an on-chain
      // program, and no funds leave the org — the shares come back to the same
      // custody wallet. Family rules are opt-in (a rule listing no families
      // matches everything), so wallet deny rules, amount limits and approval
      // requirements still apply; only a rule that explicitly enumerates
      // families would need `program` added to it.
      operationFamily: "program",
      operationType: "earn_vault_deposit",
      // The DEPOSIT token, from the catalogue row. Named so an asset-scoped
      // rule ("never move USDT") can see what is actually moving.
      asset: strategy.deposit_mints[0] ?? null,
      amount: parsed.data.amount,
      // The vault account, which is emphatically NOT a payable address —
      // funds sent to it directly are destroyed. It is carried because a
      // destination-scoped rule still needs to name the thing being deposited
      // into, and it is the only stable identifier for that.
      destination: strategy.provider_reference,
      context: {
        provider: strategy.provider,
        strategyId: strategy.id,
        strategyName: strategy.name,
        hostCluster: strategy.host_cluster,
        environment,
        depositStyle: "vault_direct",
        ...(parsed.data.minSharesOut === undefined
          ? {}
          : { minSharesOut: parsed.data.minSharesOut }),
      },
      providerExtensions: {},
    },
    legs: [],
    body: parsed.data,
    resolved,
    rawPayload: { ...(body as Record<string, unknown>) },
  };
}

function resolveEarnVaultCustodyWallet(
  wallets: readonly CustodyWallet[],
  custodyWalletId: string
): CustodyWallet {
  const exact = wallets.find((wallet) => wallet.id === custodyWalletId);
  if (exact) return exact;
  throw walletNotFound();
}

function assertBoundWalletIdentifierIsUnique(
  auth: EarnVaultDepositResolved["auth"],
  wallets: readonly CustodyWallet[],
  wallet: CustodyWallet
): void {
  const selectedScope =
    auth.authType === "api_key" &&
    (auth.walletBindings.length > 0 ||
      auth.signingWalletId !== null ||
      auth.signingWalletIds.length > 0);
  if (!selectedScope) return;

  if (wallets.filter((candidate) => candidate.walletId === wallet.walletId).length !== 1) {
    throw new AppError(
      "FORBIDDEN",
      "The selected API-key wallet binding is ambiguous across custody configurations"
    );
  }
}

/**
 * GET /v1/earn/vault-positions — the org's vault positions, HYDRATED LIVE.
 *
 * The DB rows are only the claim set (which wallet holds which vault). Shares
 * and value are read from chain on every request, never persisted: for a
 * non-custodial vault the chain IS the provider, and ADR 0002's rule is that
 * positions are provider truth read live.
 *
 * NO provider gate here. This is a READ of money the org already holds, and
 * ADR 0002's exit-safety asymmetry says un-offering or un-entitling a provider
 * must never hide a position — it closes the door in, never the door out. The
 * money-in route above takes both gates; this one deliberately takes neither.
 */
export async function listEarnVaultPositions(c: AppContext) {
  const query = parseQuery(c, earnVaultPositionsQuerySchema);
  const before = query.before ? decodeVaultPositionCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid vault position pagination cursor");
  }
  const environment = resolveSdpEnvironment(c);
  const { auth, wallets } = await resolveScope(c);

  // WALLET-BINDING SCOPE, applied before the query and therefore before any
  // chain read. A selected-wallet key must not hydrate — or even learn of —
  // positions held by wallets it is not bound to.
  //
  // The id spaces differ and that is the trap here: this helper returns PROVIDER
  // wallet ids (`privy_…`), while `earn_vault_positions.custody_wallet_id` is
  // the `custody_wallets` row id (`cwlt_…`). `scope.wallets` carries both, so it
  // is the translation table. Passing the allow-list straight through would
  // match nothing and silently return an empty page — a filter that looks like
  // it works and hides everything.
  const allowedProviderWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["earn:read"]);
  const allowed = allowedProviderWalletIds === null ? null : new Set(allowedProviderWalletIds);
  const scopedProviderWalletCounts = new Map<string, number>();
  for (const wallet of wallets) {
    scopedProviderWalletCounts.set(
      wallet.walletId,
      (scopedProviderWalletCounts.get(wallet.walletId) ?? 0) + 1
    );
  }
  const scopedWallets = wallets.filter(
    (wallet) =>
      allowed === null ||
      (allowed.has(wallet.walletId) && scopedProviderWalletCounts.get(wallet.walletId) === 1)
  );
  const custodyWalletIds = [...new Set(scopedWallets.map((wallet) => wallet.id))];
  if (custodyWalletIds.length === 0) {
    return success(c, { positions: [], hasMore: false, nextCursor: null });
  }

  const repo = createPostgresEarnVaultRepository(getDb(c.env));
  const { rows, hasMore } = await repo.listPositions({
    organizationId: auth.organizationId,
    environment,
    custodyWalletIds,
    limit: query.limit,
    ...(before === null ? {} : { before }),
  });

  // Group by provider so each client reads its whole shelf in one pass, sharing
  // one slot across the vaults — a per-position read would price a multi-vault
  // page against drifting slots.
  const byProvider = new Map<string, typeof rows>();
  for (const row of rows) {
    const providerRows = byProvider.get(row.provider);
    if (providerRows) providerRows.push(row);
    else byProvider.set(row.provider, [row]);
  }

  const walletAddresses = new Map(
    scopedWallets.map((wallet) => [wallet.id, wallet.publicKey] as const)
  );
  const live = new Map<
    string,
    {
      shares: string;
      tokenValue?: string;
    }
  >();
  const hydrationJobs: Array<() => Promise<void>> = [];
  const deadline = createVaultDeadline();

  for (const [provider, providerRows] of byProvider) {
    const client = resolveVaultDirectClient(c.env, provider, deadline);
    if (!client) continue;
    const byWallet = new Map<string, typeof rows>();
    for (const row of providerRows) {
      const walletRows = byWallet.get(row.custody_wallet_id);
      if (walletRows) walletRows.push(row);
      else byWallet.set(row.custody_wallet_id, [row]);
    }
    for (const [walletId, walletRows] of byWallet) {
      const owner = walletAddresses.get(walletId);
      if (!owner) continue;
      const trustedIdentity = new Map(
        walletRows.map((row) => [
          row.provider_reference,
          { tokenMint: row.token_mint, shareMint: row.share_mint },
        ])
      );
      const references = walletRows.map((row) => row.provider_reference);
      hydrationJobs.push(async () => {
        const snapshots = await client.readVaultPositions(earnRuntime(c), {
          owner,
          providerReferences: references,
        });
        for (const snapshot of snapshots) {
          const trusted = trustedIdentity.get(snapshot.providerReference);
          if (
            !trusted ||
            snapshot.owner !== owner ||
            snapshot.cluster !== earnClusterFor(environment) ||
            snapshot.tokenMint !== trusted.tokenMint ||
            snapshot.shareMint !== trusted.shareMint ||
            !isBoundedSnapshotAmount(snapshot.shares) ||
            (snapshot.tokenValue !== undefined && !isBoundedSnapshotAmount(snapshot.tokenValue))
          ) {
            getLogger().warn(
              {
                provider,
                walletId,
                providerReference: snapshot.providerReference,
                snapshotOwner: snapshot.owner,
                snapshotCluster: snapshot.cluster,
                snapshotTokenMint: snapshot.tokenMint,
                snapshotShareMint: snapshot.shareMint,
              },
              "vault position: ignored live snapshot with mismatched identity"
            );
            continue;
          }
          live.set(vaultPositionLiveKey(provider, walletId, snapshot.providerReference), {
            shares: snapshot.shares,
            ...(snapshot.tokenValue === undefined ? {} : { tokenValue: snapshot.tokenValue }),
          });
        }
      });
    }
  }

  if (hydrationJobs.length > 0) {
    // Failed reads intentionally leave only their rows unhydrated; never report
    // zero when the chain could not be read. In-flight RPC work stays bounded.
    await mapSettledWithConcurrency(hydrationJobs, 8, (hydrate) => hydrate());
  }

  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeVaultPositionCursor(last.created_at, last.id) : null;

  return success(c, {
    positions: rows.map((row) => {
      const hydrated = live.get(
        vaultPositionLiveKey(row.provider, row.custody_wallet_id, row.provider_reference)
      );
      return {
        id: row.id,
        provider: row.provider,
        providerReference: row.provider_reference,
        label: row.label,
        custodyWalletId: row.custody_wallet_id,
        tokenMint: row.token_mint,
        shareMint: row.share_mint,
        createdAt: row.created_at,
        closedAt: row.closed_at,
        // Absent (not zero) when the chain read failed or returned nothing.
        shares: hydrated?.shares,
        tokenValue: hydrated?.tokenValue,
      };
    }),
    hasMore,
    nextCursor,
  });
}

function vaultPositionLiveKey(provider: string, walletId: string, reference: string): string {
  return JSON.stringify([provider, walletId, reference]);
}

function isBoundedSnapshotAmount(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && isDecimalString(value);
}

const vaultPositionCursorSchema = z.object({
  // `created_at` is ordered as canonical UTC text, so accepting offsets or a
  // different precision would make a syntactically valid cursor sort wrongly.
  createdAt: z.string().datetime({ precision: 3 }),
  id: z.templateLiteral(["earn_vault_position_", z.uuidv4()]),
});

function encodeVaultPositionCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeVaultPositionCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const separator = decoded.indexOf("|");
    if (separator <= 0 || separator === decoded.length - 1) return null;
    const parsed = vaultPositionCursorSchema.safeParse({
      createdAt: decoded.slice(0, separator),
      id: decoded.slice(separator + 1),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
