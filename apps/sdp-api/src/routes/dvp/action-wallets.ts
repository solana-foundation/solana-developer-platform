import { address } from "@solana/kit";
import { getDb } from "@/db/client";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { pickPartyWalletId } from "@/services/dvp/custody-party";
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
  callerAddresses: ReadonlyMap<string, DvpCallerWallet>,
  /** Whether the caller may perform `dvp.execute` (`callerMayPerform`): only then are wallets actionable. */
  callerMayExecute: boolean
): Promise<Map<string, DvpActionWallet>> {
  const result = new Map<string, DvpActionWallet>();
  if (!callerMayExecute) {
    return result;
  }
  const addresses = [...new Set(partyAddresses)].filter((key) => callerAddresses.has(key));
  if (addresses.length === 0) return result;

  const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
  const wallets = await targets.listWallets({
    organizationId: request.organizationId,
    projectId: request.projectId,
  });
  const visible = new Map(wallets.map((wallet) => [wallet.id, wallet]));

  const candidates = await targets.findOperationalWalletIdsByAddresses({
    organizationId: request.organizationId,
    projectId: request.projectId,
    publicKeys: addresses.map((key) => address(key)),
  });
  for (const key of addresses) {
    // The candidate funding uses (`custodyWalletForParty`, the same pick); a
    // hidden choice must never fall back to another signer.
    const id = pickPartyWalletId(candidates.get(key) ?? [], request.auth.walletAccess);
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
