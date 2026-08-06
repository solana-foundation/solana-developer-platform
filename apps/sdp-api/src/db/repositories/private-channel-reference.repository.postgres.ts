import type { AppDb } from "@/db";
import type {
  ListPrivateChannelReferencesParams,
  PrivateChannelReferenceRepository,
  PrivateChannelReferenceRow,
} from "./private-channel-reference.repository";

/**
 * A dictionary this large is already unusable as a display aid, and truncating
 * only degrades unresolved ids to their shortened form, so the cap protects the
 * response size without a failure mode.
 */
const MAX_REFERENCES = 2000;

type Bind = string | string[];

interface ReferenceBranch {
  sql: string;
  binds: Bind[];
}

function mapReferenceRow(row: Record<string, unknown>): PrivateChannelReferenceRow {
  return {
    kind: row.kind as PrivateChannelReferenceRow["kind"],
    key: row.key as string,
    name: row.name as string,
  };
}

export function createPostgresPrivateChannelReferenceRepository(
  db: AppDb
): PrivateChannelReferenceRepository {
  return {
    async listReferences(params: ListPrivateChannelReferencesParams) {
      const { organizationId, projectId, viewer } = params;

      // Empty for full viewers, so the same branch serves both scopes.
      const viewerChannels = viewer ? "AND pc.id = ANY(?::text[])" : "";
      const viewerMembers = viewer
        ? `AND (
             pcu.user_id = ?
             OR EXISTS (
               SELECT 1
                 FROM private_channel_memberships m
                WHERE m.private_channel_user_id = pcu.id
                  AND m.channel_id = ANY(?::text[])
             )
           )`
        : "";

      const branches: ReferenceBranch[] = [
        // Channels: a member only resolves names for channels they belong to.
        // Archived channels are kept so retained history stays readable.
        {
          sql: `SELECT 'channel' AS kind, pc.id AS key, pc.name AS name
                  FROM private_channels pc
                 WHERE pc.organization_id = ?
                   AND pc.project_id = ?
                   ${viewerChannels}`,
          binds: viewer
            ? [organizationId, projectId, viewer.channelIds]
            : [organizationId, projectId],
        },

        // Payloads reference a wallet by address or by id, so one row per key
        // names both. Not viewer-narrowed: custody labels are already readable by
        // anyone holding wallets:read, which every role with payments:read has.
        {
          sql: `SELECT 'wallet' AS kind, k.key AS key,
                       COALESCE(NULLIF(w.label, ''), w.wallet_id) AS name
                  FROM custody_wallets w
                  JOIN custody_configs cc ON cc.id = w.custody_config_id
                  CROSS JOIN unnest(ARRAY[w.public_key, w.wallet_id]) AS k(key)
                 WHERE cc.organization_id = ?
                   AND (cc.project_id IS NULL OR cc.project_id = ?)`,
          binds: [organizationId, projectId],
        },

        // Members are keyed by private-channel-user id and by SDP user id. A
        // member resolves themselves plus anyone sharing one of their channels.
        {
          sql: `SELECT 'member' AS kind, k.key AS key,
                       COALESCE(NULLIF(u.name, ''), u.email) AS name
                  FROM private_channel_users pcu
                  JOIN users u ON u.id = pcu.user_id
                  CROSS JOIN unnest(ARRAY[pcu.id, pcu.user_id]) AS k(key)
                 WHERE pcu.organization_id = ?
                   AND pcu.project_id = ?
                   ${viewerMembers}`,
          binds: viewer
            ? [organizationId, projectId, viewer.userId, viewer.channelIds]
            : [organizationId, projectId],
        },

        // Tokens the project issued, so a mint address can read as its symbol.
        // Mints and symbols are public on-chain data, and well-known mints are
        // named client-side from the shared catalogue.
        {
          sql: `SELECT 'token' AS kind, it.mint_address AS key,
                       COALESCE(NULLIF(it.symbol, ''), it.name) AS name
                  FROM issued_tokens it
                 WHERE it.organization_id = ?
                   AND it.project_id = ?
                   AND it.mint_address IS NOT NULL`,
          binds: [organizationId, projectId],
        },
      ];

      // Gateway URLs are infrastructure endpoints, and the instance lifecycle
      // events carrying them have no channel, so members never see those events.
      if (!viewer) {
        branches.push({
          sql: `SELECT 'instance' AS kind, pci.id AS key, pci.gateway_url AS name
                  FROM private_channel_instances pci
                 WHERE pci.organization_id = ?
                   AND pci.project_id = ?`,
          binds: [organizationId, projectId],
        });
      }

      const sql = `SELECT kind, key, name
                     FROM (
                       ${branches.map((branch) => branch.sql).join("\n UNION ALL \n")}
                     ) refs
                    LIMIT ${MAX_REFERENCES}`;

      const { results = [] } = await db
        .prepare(sql)
        .bind(...branches.flatMap((branch) => branch.binds))
        .all<Record<string, unknown>>();
      return results.map(mapReferenceRow);
    },
  };
}
