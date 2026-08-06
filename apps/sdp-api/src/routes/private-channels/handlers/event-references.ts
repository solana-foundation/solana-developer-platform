import { hasPermission } from "@sdp/types";
import { getAuth, requireProjectId } from "@/lib/auth";
import { success } from "@/lib/response";
import type { AppContext } from "../context";
import { getPrivateChannelReferenceRepository } from "../context";
import { resolveEventViewer } from "../event-access";

/**
 * GET /events/references — flat id→name dictionary for event enrichment.
 * Channels and members follow the same viewer rules as the events feed.
 * Issued-token symbols are project-wide (public on-chain data), and wallet
 * labels need the same wallets:read the custody endpoints require.
 */
export async function listPrivateChannelEventReferences(c: AppContext) {
  const { organizationId, permissions } = getAuth(c);
  const projectId = requireProjectId(c);
  const viewer = await resolveEventViewer(c);
  if (viewer.scope === "none") {
    return success(c, { references: {} });
  }

  const rows = await getPrivateChannelReferenceRepository(c).listReferences({
    organizationId,
    projectId,
    includeWalletLabels: hasPermission(permissions, "wallets:read"),
    viewer:
      viewer.scope === "member"
        ? { channelIds: viewer.channelIds, userId: viewer.userId }
        : undefined,
  });

  // One flat namespace: ids are prefixed per entity (pch_, pcu_, usr_, pci_) and
  // wallet/mint keys are base58, so no two kinds can claim the same key.
  return success(c, {
    references: Object.fromEntries(rows.map((row) => [row.key, row.name])),
  });
}
