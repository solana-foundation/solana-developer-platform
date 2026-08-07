import { hasPermission } from "@sdp/types";
import type { PrivateChannelReferenceWalletScope } from "@/db/repositories";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import { success } from "@/lib/response";
import { getAllowedApiKeyWalletIdsForPermissions } from "@/services/api-key-scope.service";
import type { AppContext } from "../context";
import { getPrivateChannelReferenceRepository } from "../context";
import { resolveEventViewer } from "../event-access";

function resolveWalletScope(auth: ApiKeyContext): PrivateChannelReferenceWalletScope {
  if (!hasPermission(auth.permissions, "wallets:read")) {
    return { scope: "none" };
  }

  const walletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["wallets:read"]);
  if (walletIds === null) {
    return { scope: "all" };
  }
  return walletIds.length > 0 ? { scope: "selected", walletIds } : { scope: "none" };
}

/**
 * GET /events/references — flat id→name dictionary for event enrichment.
 * Channels and members follow the same viewer rules as the events feed.
 * Issued-token symbols are project-wide (public on-chain data), and wallet
 * labels follow the same wallets:read and selected-wallet scope as custody.
 */
export async function listPrivateChannelEventReferences(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const viewer = await resolveEventViewer(c);
  if (viewer.scope === "none") {
    return success(c, { references: {} });
  }

  const rows = await getPrivateChannelReferenceRepository(c).listReferences({
    organizationId: auth.organizationId,
    projectId,
    walletScope: resolveWalletScope(auth),
    viewer,
  });

  // One flat namespace: ids are prefixed per entity (pch_, pcu_, usr_, pci_) and
  // wallet/mint keys are base58, so no two kinds can claim the same key.
  return success(c, {
    references: Object.fromEntries(rows.map((row) => [row.key, row.name])),
  });
}
