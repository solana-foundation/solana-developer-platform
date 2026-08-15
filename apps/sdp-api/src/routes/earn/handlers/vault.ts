import { earnDepositStyle, isEarnProviderSurfaced } from "@sdp/types/provider-access";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
import { requireProjectId } from "@/lib/auth";
import { badRequest, notFound, walletNotFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import { resolveVaultDirectClient } from "@/services/earn/execution-registry";
import { depositIntoVault } from "@/services/earn/vault-deposit.service";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import type { AppContext } from "../context";
import { earnRuntime, getEarnRepository, resolveSdpEnvironment } from "../context";
import { earnVaultDepositSchema } from "../schemas";

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

  // A mainnet instrument must never be funded from a sandbox project (and vice
  // versa). `host_cluster` states where the vault actually lives; the sync
  // already refuses to store a mismatch, so this is the second, per-request
  // guard rather than the only one.
  const expectedCluster = environment === "production" ? "mainnet-beta" : "devnet";
  if (strategy.host_cluster !== expectedCluster) {
    throw badRequest(
      `This vault lives on ${strategy.host_cluster}, which is not fundable from a ${environment} project.`
    );
  }

  // MONEY-IN GATES, in the same order and with the same meaning as
  // `POST /programs` (see routes/earn/CLAUDE.md → "Gate asymmetry"). Opening a
  // vault position is a new commitment, so it takes both:
  //
  //   surfacing  — "SDP does not offer this provider", which no per-org
  //                override can lift, and which reads differently from
  //                entitlement. Checked first so a caller is never pointed at
  //                an activation door that does not exist.
  //   entitlement — the org's own override plus the environment's credentials.
  //
  // Money-OUT must never inherit either of these (ADR 0002): un-offering a
  // provider closes the door in, never the door out.
  if (!isEarnProviderSurfaced(strategy.provider)) {
    throw badRequest(`${strategy.provider} is not currently offered.`);
  }
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    auth.organizationId,
    "earn",
    strategy.provider as never,
    environment === "sandbox"
  );

  // The wallet must be one SDP can sign for, resolved through the same
  // permission-checked helper the payments and private-channel deposits use.
  const walletAddress = resolveWalletAddress(wallets, parsed.data.walletId, "walletId", auth, [
    "wallets:read",
  ]);
  const wallet = wallets.find((candidate) => candidate.publicKey === walletAddress);
  if (!wallet) {
    throw walletNotFound();
  }

  const result = await depositIntoVault(c.env, {
    organizationId: auth.organizationId,
    projectId,
    environment,
    provider: strategy.provider,
    providerReference: strategy.provider_reference,
    wallet,
    amount: parsed.data.amount,
    requestId: parsed.data.requestId,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
    ...(parsed.data.minSharesOut === undefined ? {} : { minSharesOut: parsed.data.minSharesOut }),
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
  const { auth } = await resolveScope(c);
  const repo = createPostgresEarnVaultRepository(getDb(c.env));
  const rows = await repo.listPositions({
    organizationId: auth.organizationId,
    environment,
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
