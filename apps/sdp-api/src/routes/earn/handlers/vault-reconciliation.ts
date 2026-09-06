import { createRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { success } from "@/lib/response";
import { getSplTokenBalances } from "@/routes/payments/token-accounts";
import {
  assertClusterEndpoint,
  earnClusterFor,
  resolveClusterRpcUrl,
} from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { reconcileVaultShareHoldings } from "@/services/earn/vault-share-reconciliation.service";
import type { AppContext } from "../context";
import { getEarnRepository, resolveSdpEnvironment } from "../context";
import { listReadableEarnVaultWallets } from "./vault";

/**
 * GET /v1/earn/vault-share-reconciliation — custody share balances versus the
 * recorded claim set, both directions (PRO-1741).
 *
 * `GET /vault-positions` can only report what SDP recorded, and the recorded
 * set can genuinely diverge from chain: `self_service` custody credentials let
 * an org sign from the same wallet outside SDP. This read enumerates each
 * scoped wallet's SPL balances, attributes share mints through the stored
 * catalogue, and reports the two disagreements — a held share balance with no
 * visible claim, and a claim whose wallet holds none of its shares.
 *
 * REPORT-ONLY: it writes nothing, adopts nothing, closes nothing (the service
 * header carries the why). NO provider gate, same ADR 0002 reason as the
 * positions read — this reports on money the org already holds. It DOES take
 * the positions read's exact wallet-binding scope: a bound key that cannot see
 * wallet B's positions must not learn wallet B's balances here either.
 *
 * The endpoint is genesis-proven before any balance read: a misconfigured or
 * wrong-cluster RPC must fail the whole pass (positions untouched, failure
 * reported as an error) rather than read the wrong chain and report every
 * position unbacked. Per-wallet read failures degrade instead to a named
 * `unreadableWallets` entry, and that wallet's claims go unjudged. The whole
 * pass shares one `VaultDeadline`, the same absolute budget every vault
 * workflow runs under, so a data-driven wallet count bounds what gets read,
 * never how long the request runs.
 */
export async function getEarnVaultShareReconciliation(c: AppContext) {
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  // A wallet can be projected once per custody config; reconcile each row once.
  const walletsById = new Map<string, { id: string; publicKey: string }>();
  for (const wallet of scopedWallets) {
    if (!walletsById.has(wallet.id)) {
      walletsById.set(wallet.id, { id: wallet.id, publicKey: wallet.publicKey });
    }
  }
  if (walletsById.size === 0) {
    return success(c, { unrecordedHoldings: [], unbackedPositions: [], unreadableWallets: [] });
  }

  const cluster = earnClusterFor(environment);
  const [claims, strategies] = await Promise.all([
    createPostgresEarnMovementsRepository(getDb(c.env)).listVaultClaimsForReconciliation({
      organizationId: auth.organizationId,
      environment,
      custodyWalletIds: [...walletsById.keys()],
    }),
    getEarnRepository(c).listShareMintedStrategies({ environment, hostCluster: cluster }),
  ]);

  const rpcUrl = resolveClusterRpcUrl(c.env, cluster);
  await assertClusterEndpoint(c.env, cluster, rpcUrl);
  const rpc = createRpc(c.env, { rpcUrl });

  const report = await reconcileVaultShareHoldings({
    wallets: [...walletsById.values()],
    claims,
    strategies,
    readBalances: (ownerAddress) =>
      getSplTokenBalances(rpc, assertValidAddress(ownerAddress, "custodyWallet")),
    deadline: createVaultDeadline(),
  });

  return success(c, report);
}
