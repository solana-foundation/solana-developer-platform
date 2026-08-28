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
  const hydrationJobs: Array<() => Promise<void>> = [];
  const deadline = createVaultDeadline();

  for (const [provider, providerPositions] of byProvider) {
    const client = resolveVaultDirectClient(c.env, provider, deadline);
    if (!client) continue;

    const byOwner = new Map<string, HydratableVaultPosition[]>();
    for (const position of providerPositions) {
      const ownerPositions = byOwner.get(position.ownerAddress);
      if (ownerPositions) ownerPositions.push(position);
      else byOwner.set(position.ownerAddress, [position]);
    }

    for (const [owner, ownerPositions] of byOwner) {
      const trustedByReference = new Map(
        ownerPositions.map((position) => [position.providerReference, position] as const)
      );
      hydrationJobs.push(async () => {
        const snapshots = await client.readVaultPositions(earnRuntime(c), {
          owner,
          providerReferences: ownerPositions.map((position) => position.providerReference),
        });
        for (const snapshot of snapshots) {
          const trusted = trustedByReference.get(snapshot.providerReference);
          if (
            !trusted ||
            snapshot.owner !== owner ||
            snapshot.cluster !== earnClusterFor(environment) ||
            snapshot.tokenMint !== trusted.tokenMint ||
            snapshot.shareMint !== trusted.shareMint ||
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
          live.set(trusted.id, {
            shares: snapshot.shares,
            withdrawableShares: snapshot.withdrawableShares,
            tokenValue: snapshot.tokenValue,
          });
        }
      });
    }
  }

  if (hydrationJobs.length > 0) {
    await mapSettledWithConcurrency(hydrationJobs, 8, (hydrate) => hydrate());
  }
  return live;
}

function isBoundedSnapshotAmount(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && isDecimalString(value);
}
