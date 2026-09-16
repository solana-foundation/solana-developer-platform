import { address } from "@solana/kit";
import { getDb } from "@/db/client";
import { getAllowedApiKeyCustodyWalletIdsForPermissions } from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { selectPartyWalletId } from "@/services/dvp/custody-party";
import type { DvpCallerWallet, DvpInboundRequest } from "@/services/dvp/inbound";
import type { Env } from "@/types/env";

export interface DvpActionWallet extends DvpCallerWallet {
  isRuntimeExecutionAllowed: boolean;
}

/**
 * Projects the existing funding choice without changing read discovery.
 * A runtime-disabled choice stays visible; it never selects a different signer.
 * Write-only wallet metadata is withheld, even when it holds a readable address.
 */
export async function readDvpActionWallets(
  env: Env,
  request: DvpInboundRequest,
  partyAddresses: string[],
  callerAddresses: ReadonlyMap<string, DvpCallerWallet>
): Promise<Map<string, DvpActionWallet>> {
  const result = new Map<string, DvpActionWallet>();
  if (
    !request.auth.permissions.includes("*") &&
    !request.auth.permissions.includes("payments:write")
  ) {
    return result;
  }
  const addresses = [...new Set(partyAddresses)].filter((key) => callerAddresses.has(key));
  if (addresses.length === 0) return result;

  const readable = getAllowedApiKeyCustodyWalletIdsForPermissions(request.auth, ["wallets:read"]);
  const writable = getAllowedApiKeyCustodyWalletIdsForPermissions(request.auth, ["payments:write"]);
  const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
  const wallets = await targets.listWallets({
    organizationId: request.organizationId,
    projectId: request.projectId,
    includeAllProviders: true,
  });
  const visible = new Map(
    wallets
      .filter((wallet) => readable === null || readable.includes(wallet.id))
      .map((wallet) => [wallet.id, wallet])
  );

  const candidates = await targets.findOperationalWalletIdsByAddresses({
    organizationId: request.organizationId,
    projectId: request.projectId,
    publicKeys: addresses.map((key) => address(key)),
  });
  for (const key of addresses) {
    // Choose by write scope before applying read visibility: a hidden or
    // restricted first choice must never fall back to another signer.
    const id = selectPartyWalletId(candidates.get(key) ?? [], writable);
    const wallet = id === null ? undefined : visible.get(id);
    if (wallet?.publicKey === key) {
      result.set(key, {
        id: wallet.id,
        name: wallet.label,
        isRuntimeExecutionAllowed: wallet.isRuntimeExecutionAllowed,
      });
    }
  }
  return result;
}
