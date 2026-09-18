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
  /** Provider-reported Unix epoch seconds; null means no active lock. */
  unlockTimestamp?: string | null;
}

export interface VaultPositionHydrationOptions {
  ownerKind: "custody" | "external-wallet";
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
  positions: readonly HydratableVaultPosition[],
  options: VaultPositionHydrationOptions
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
              (snapshot.tokenValue !== undefined &&
                !isBoundedSnapshotAmount(snapshot.tokenValue)) ||
              !isBoundedOptionalEpoch(snapshot.unlockTimestamp)
            ) {
              getLogger().warn(
                {
                  provider,
                  ...ownerTelemetryFields(options.ownerKind, owner, snapshot.owner),
                  providerReference: snapshot.providerReference,
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
                unlockTimestamp: snapshot.unlockTimestamp,
              });
            }
            if (!matched) {
              getLogger().warn(
                {
                  provider,
                  ...ownerTelemetryFields(options.ownerKind, owner),
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
          ...(job ? ownerTelemetryFields(options.ownerKind, job.owner) : {}),
          positionCount: job?.positionCount,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        "vault position: live hydration unavailable"
      );
    });
  }
  return live;
}

/** End-user owner addresses are omitted before the payload reaches the logger. */
function ownerTelemetryFields(
  ownerKind: VaultPositionHydrationOptions["ownerKind"],
  owner: string,
  snapshotOwner?: string
): { owner?: string; snapshotOwner?: string; ownerMismatch?: boolean } {
  if (ownerKind === "external-wallet") {
    return snapshotOwner === undefined ? {} : { ownerMismatch: snapshotOwner !== owner };
  }
  return {
    owner,
    ...(snapshotOwner === undefined ? {} : { snapshotOwner }),
  };
}

function isBoundedSnapshotAmount(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && isDecimalString(value);
}

function isBoundedOptionalEpoch(value: unknown): value is string | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || value.length > 20 || !/^\d+$/.test(value)) return false;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return false;
  return Number.isFinite(new Date(seconds * 1_000).getTime());
}

/**
 * Close holdings the live read has just proven empty.
 *
 * Settlement closes a position when its exit empties it, but a position exited
 * before that close-out existed, or whose close-out lost its chain read, would
 * otherwise stay open with zero shares and keep counting as live. The next read
 * that observes an exact "0" closes it. The repository refuses while a movement
 * is unsettled or when the row changed after the snapshot was taken, and a
 * later deposit re-opens the row, so this can only ever retire a holding that
 * is truly empty. Fail-soft: this page still answers as
 * observed, and the close is retried by the next read.
 */
export async function closeEmptyHydratedPositions(
  close: (positionId: string, observedUpdatedAt: string) => Promise<boolean>,
  positions: ReadonlyArray<{ id: string; closedAt: string | null; updatedAt: string }>,
  live: ReadonlyMap<string, HydratedVaultPositionValue>
): Promise<void> {
  const empty = positions.filter(
    (position) => position.closedAt === null && live.get(position.id)?.shares === "0"
  );
  await Promise.all(
    empty.map(async (position) => {
      try {
        // `updatedAt` was read with the row, BEFORE the live balance: it is the
        // snapshot boundary the repository checks under the position lock.
        await close(position.id, position.updatedAt);
      } catch (error) {
        getLogger().warn(
          { positionId: position.id, error },
          "vault position close-out on read failed; the next read retries"
        );
      }
    })
  );
}
