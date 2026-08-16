import type { SdpEnvironment } from "@sdp/types";
import { earnDepositStyle, isVaultDirectDepositEnabled } from "@sdp/types/provider-access";
import { z } from "zod";
import { getDb } from "@/db";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
import { requireProjectId } from "@/lib/auth";
import { AppError, badRequest, notFound, walletNotFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import { getAllowedApiKeyWalletIdsForPermissions } from "@/services/api-key-scope.service";
import { resolveVaultDirectClient } from "@/services/earn/execution-registry";
import { depositIntoVault } from "@/services/earn/vault-deposit.service";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import {
  assertEarnProviderSurfaced,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "../context";
import { earnRuntime, getEarnRepository, resolveSdpEnvironment } from "../context";
import { earnVaultDepositSchema } from "../schemas";
import { assertStrategyDepositable } from "./admission";

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

  const result = await depositIntoVault(c.env, {
    organizationId: auth.organizationId,
    projectId,
    environment,
    provider: strategy.provider,
    providerReference: strategy.provider_reference,
    wallet,
    amount: parsedData.amount,
    requestId: parsedData.requestId,
    minSharesOut: parsedData.minSharesOut,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
  });

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
  const walletAddress = resolveWalletAddress(wallets, parsed.data.walletId, "walletId", auth, [
    "earn:write",
  ]);
  const wallet = wallets.find((candidate) => candidate.publicKey === walletAddress);
  if (!wallet) {
    // Also closes the raw-address bypass: `resolveWalletAddress` returns an
    // unknown base58 address unchecked, treating it as an external destination.
    // For money-IN the wallet must be one SDP holds keys for.
    throw walletNotFound();
  }

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
  let custodyWalletIds: string[] | undefined;
  if (allowedProviderWalletIds !== null) {
    const allowed = new Set(allowedProviderWalletIds);
    custodyWalletIds = wallets
      .filter((wallet) => allowed.has(wallet.walletId))
      .map((wallet) => wallet.id);
    // Bound, but nothing qualifies: answer empty WITHOUT querying. `null` means
    // unbound and takes no filter at all; `[]` here would otherwise widen back
    // to "no filter" in the repository.
    if (custodyWalletIds.length === 0) {
      return success(c, { positions: [] });
    }
  }

  const repo = createPostgresEarnVaultRepository(getDb(c.env));
  const rows = await repo.listPositions({
    organizationId: auth.organizationId,
    environment,
    ...(custodyWalletIds === undefined ? {} : { custodyWalletIds }),
  });

  // Group by provider so each client reads its whole shelf in one pass, sharing
  // one slot across the vaults — a per-position read would price a multi-vault
  // page against drifting slots.
  const byProvider = new Map<string, typeof rows>();
  for (const row of rows) {
    byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row]);
  }

  const live = new Map<string, { shares: string; tokenValue?: string }>();
  await Promise.all(
    [...byProvider.entries()].map(async ([provider, providerRows]) => {
      const client = resolveVaultDirectClient(c.env, provider);
      if (!client) return;
      // Positions are grouped per WALLET too: one owner per read.
      const byWallet = new Map<string, string[]>();
      for (const row of providerRows) {
        byWallet.set(row.custody_wallet_id, [
          ...(byWallet.get(row.custody_wallet_id) ?? []),
          row.provider_reference,
        ]);
      }
      const walletAddresses = await resolveWalletAddresses(c, [...byWallet.keys()]);
      await Promise.all(
        [...byWallet.entries()].map(async ([walletId, references]) => {
          const owner = walletAddresses.get(walletId);
          if (!owner) return;
          try {
            const snapshots = await client.readVaultPositions(earnRuntime(c), {
              owner,
              providerReferences: references,
            });
            for (const snapshot of snapshots) {
              live.set(`${walletId}:${snapshot.providerReference}`, {
                shares: snapshot.shares,
                ...(snapshot.tokenValue === undefined ? {} : { tokenValue: snapshot.tokenValue }),
              });
            }
          } catch {
            // A failed chain read leaves this position unhydrated rather than
            // failing the whole list — the reader still sees that they hold it.
            // Reporting zero would be a claim about their money that a failed
            // RPC call does not support.
          }
        })
      );
    })
  );

  return success(c, {
    positions: rows.map((row) => {
      const hydrated = live.get(`${row.custody_wallet_id}:${row.provider_reference}`);
      return {
        id: row.id,
        provider: row.provider,
        providerReference: row.provider_reference,
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
  });
}

/** Map custody wallet row ids to their public keys, for the chain reads above. */
async function resolveWalletAddresses(
  c: AppContext,
  walletRowIds: readonly string[]
): Promise<Map<string, string>> {
  const { wallets } = await resolveScope(c);
  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet.publicKey]));
  return new Map(
    walletRowIds.flatMap((id) => {
      const publicKey = byId.get(id);
      return publicKey ? [[id, publicKey] as [string, string]] : [];
    })
  );
}
