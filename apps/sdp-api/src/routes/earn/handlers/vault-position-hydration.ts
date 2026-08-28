import { isDecimalString } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { getLogger } from "@/runtime/logger";
import { earnClusterFor, resolveVaultDirectClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import type { AppContext } from "../context";
import { earnRuntime } from "../context";

/** A persisted vault claim with the live-read owner resolved. */
export interface HydratableVaultPosition {
  id: string;
  provider: string;
  providerReference: string;
  ownerAddress: string;
  tokenMint: string;
  shareMint: string;
}

export interface HydratedVaultPositionValue {
  shares: string;
  withdrawableShares: string;
  tokenValue: string | undefined;
}

/**
 * Hydrate vault claims in bounded owner/provider batches.
 *
 * Both SDP-custody and external-wallet reads use this exact identity check and
 * failure posture: provider failures leave the affected value unavailable,
 * while a mismatched owner, cluster, vault, or mint is ignored rather than
 * attached to somebody else's position.
 */
export async function hydrateVaultPositions(
  c: AppContext,
  environment: SdpEnvironment,
  positions: readonly HydratableVaultPosition[]
): Promise<Map<string, HydratedVaultPositionValue>> {
  const byProvider = new Map<string, HydratableVaultPosition[]>();
  for (const position of positions) {
    const providerPositions = byProvider.get(position.provider);
    if (providerPositions) providerPositions.push(position);
    else byProvider.set(position.provider, [position]);
  }

  const live = new Map<string, HydratedVaultPositionValue>();
  const hydrationJobs: Array<{
    provider: string;
    owner: string;
    positionCount: number;
    hydrate: () => Promise<void>;
  }> = [];

  for (const [provider, providerPositions] of byProvider) {
    const byOwner = new Map<string, HydratableVaultPosition[]>();
    for (const position of providerPositions) {
      const ownerPositions = byOwner.get(position.ownerAddress);
      if (ownerPositions) ownerPositions.push(position);
      else byOwner.set(position.ownerAddress, [position]);
    }

    for (const [owner, ownerPositions] of byOwner) {
      const trustedByReference = new Map<string, HydratableVaultPosition[]>();
      for (const position of ownerPositions) {
        const trusted = trustedByReference.get(position.providerReference);
        if (trusted) trusted.push(position);
        else trustedByReference.set(position.providerReference, [position]);
      }
      hydrationJobs.push({
        provider,
        owner,
        positionCount: ownerPositions.length,
        hydrate: async () => {
          // The concurrency queue may wait behind many other owners. Give each
          // live read its own external-call budget when it actually starts.
          const client = resolveVaultDirectClient(c.env, provider, createVaultDeadline());
          if (!client) return;
          const snapshots = await client.readVaultPositions(earnRuntime(c), {
            owner,
            providerReferences: [...trustedByReference.keys()],
          });
          for (const snapshot of snapshots) {
            const trustedPositions = trustedByReference.get(snapshot.providerReference);
            if (
              !trustedPositions ||
              snapshot.owner !== owner ||
              snapshot.cluster !== earnClusterFor(environment) ||
              !isBoundedSnapshotAmount(snapshot.shares) ||
              !isBoundedSnapshotAmount(snapshot.withdrawableShares) ||
              (snapshot.tokenValue !== undefined && !isBoundedSnapshotAmount(snapshot.tokenValue))
            ) {
              getLogger().warn(
                {
                  provider,
                  owner,
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

            let matched = false;
            for (const trusted of trustedPositions) {
              if (
                snapshot.tokenMint !== trusted.tokenMint ||
                snapshot.shareMint !== trusted.shareMint
              ) {
                continue;
              }
              matched = true;
              live.set(trusted.id, {
                shares: snapshot.shares,
                withdrawableShares: snapshot.withdrawableShares,
                tokenValue: snapshot.tokenValue,
              });
            }
            if (!matched) {
              getLogger().warn(
                {
                  provider,
                  owner,
                  providerReference: snapshot.providerReference,
                  snapshotTokenMint: snapshot.tokenMint,
                  snapshotShareMint: snapshot.shareMint,
                },
                "vault position: ignored live snapshot with mismatched asset identity"
              );
            }
          }
        },
      });
    }
  }

  if (hydrationJobs.length > 0) {
    const settled = await mapSettledWithConcurrency(hydrationJobs, 8, (job) => job.hydrate());
    settled.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const job = hydrationJobs[index];
      getLogger().warn(
        {
          provider: job?.provider,
          owner: job?.owner,
          positionCount: job?.positionCount,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        "vault position: live hydration unavailable"
      );
    });
  }
  return live;
}

function isBoundedSnapshotAmount(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && isDecimalString(value);
}
