import { createHash } from "node:crypto";
import type { EarnVaultPositionSnapshot } from "@sdp/earn/types";
import { addDecimalAmounts } from "@sdp/payments/decimal";
import { resolveClusterRpcUrls } from "@sdp/rpc";
import { readStamp, withMinimumRpcSlot, withReadFloor } from "@sdp/rpc/read-context";
import { isDecimalString } from "@sdp/solana/amount";
import {
  type EarnVaultPositionIntermediate,
  isEarnVaultHoldingEmpty,
  type SdpEnvironment,
  type SolanaCluster,
} from "@sdp/types";
import { isAddress } from "@solana/kit";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { getLogger } from "@/runtime/logger";
import { earnClusterFor, resolveVaultDirectClient } from "@/services/earn/execution-registry";
import { createVaultDeadline, type VaultDeadline } from "@/services/earn/vault-deadline";
import type { AppContext } from "../context";
import { earnRuntime } from "../context";

const MAX_IN_FLIGHT_VAULT_POSITION_READS = 256;

/**
 * Stamp a caller takes as soon as its position rows are read, and passes as
 * `rowsReadAt`: no provider request its hydration uses was sent before it (see
 * `sharedVaultPositionRead`). Close-out trusts the rows' `updatedAt`. Same
 * clock as the providers' in-flight request sharing (`readStamp`).
 */
export function markVaultPositionRowsRead(): number {
  return readStamp();
}

/**
 * Provider reads in flight, keyed by everything a read depends on: environment,
 * RPC endpoints, provider, owner, the sorted references and the minimum slot.
 * Removed on settlement, so this is never a cache: it only stops overlapping
 * requests from repeating the same chain read.
 */
const inFlightVaultPositionReads = new Map<
  string,
  { read: Promise<EarnVaultPositionSnapshot[]>; startedAt: number }
>();

/**
 * Join an identical read whose creator read its rows no earlier than the
 * caller did, or start one. A read is stamped with its creator's `rowsReadAt`
 * and runs under that read floor, so every provider request it uses was sent
 * after the creator's rows were read, and so after every joiner's. Every job
 * of one hydration runs under the same floor, so owners on one page still
 * share provider requests. A joiner stops waiting at its own deadline; the
 * read itself runs on the deadline of the caller that started it.
 */
function sharedVaultPositionRead(
  key: string,
  rowsReadAt: number,
  deadline: VaultDeadline,
  read: () => Promise<EarnVaultPositionSnapshot[]>
): Promise<EarnVaultPositionSnapshot[]> {
  const existing = inFlightVaultPositionReads.get(key);
  if (existing && existing.startedAt >= rowsReadAt) {
    return deadline.run("vault position read", () => existing.read);
  }
  const entry = { startedAt: rowsReadAt, read: withReadFloor(rowsReadAt, read) };
  if (!existing && inFlightVaultPositionReads.size >= MAX_IN_FLIGHT_VAULT_POSITION_READS) {
    return entry.read;
  }
  inFlightVaultPositionReads.set(key, entry);
  const clear = () => {
    if (inFlightVaultPositionReads.get(key) === entry) inFlightVaultPositionReads.delete(key);
  };
  void entry.read.then(clear, clear);
  return entry.read;
}

/**
 * The RPC endpoints a read for `cluster` would use, in failover order, as a
 * hash: reads through different endpoints never share, and the key never
 * holds a URL (providers carry API keys in them).
 */
function rpcEndpointIdentity(env: AppContext["env"], cluster: SolanaCluster): string {
  return createHash("sha256")
    .update(JSON.stringify(resolveClusterRpcUrls(env, cluster)))
    .digest("hex")
    .slice(0, 16);
}

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
  parIntermediate?: EarnVaultPositionIntermediate;
}

/**
 * The holding's whole deposit-token value: its shares plus any par
 * intermediate. Undefined whenever the shares' own value is.
 */
export function hydratedHoldingTokenValue(
  value: HydratedVaultPositionValue | undefined
): string | undefined {
  if (value?.tokenValue === undefined) return undefined;
  return value.parIntermediate
    ? addDecimalAmounts(value.tokenValue, value.parIntermediate.tokenValue)
    : value.tokenValue;
}

export interface VaultPositionHydrationOptions {
  ownerKind: "custody" | "external-wallet";
  minimumSlotByPositionId?: ReadonlyMap<string, number>;
  /** `markVaultPositionRowsRead()`, taken once the positions' rows were read. */
  rowsReadAt: number;
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
  // One request gets one absolute provider budget. Giving every queued owner a
  // fresh deadline makes worst-case latency grow with portfolio size: eight
  // slow owners finish, then the next eight each receive another full timeout.
  // Sharing the deadline keeps the fail-soft contract while bounding the
  // route. Jobs that have not started when the budget expires are reported as
  // unavailable instead of extending caller latency indefinitely.
  const hydrationDeadline = createVaultDeadline();
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
    const byOwner = new Map<
      string,
      { owner: string; minimumSlot?: number; positions: HydratableVaultPosition[] }
    >();
    for (const position of providerPositions) {
      const minimumSlot = options.minimumSlotByPositionId?.get(position.id);
      // A transfer in one vault must not constrain another holding, even when
      // both belong to the same owner and provider.
      const key = JSON.stringify([position.ownerAddress, minimumSlot]);
      const batch = byOwner.get(key);
      if (batch) batch.positions.push(position);
      else byOwner.set(key, { owner: position.ownerAddress, minimumSlot, positions: [position] });
    }

    for (const { owner, minimumSlot, positions: ownerPositions } of byOwner.values()) {
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
          const client = resolveVaultDirectClient(c.env, provider, hydrationDeadline);
          if (!client) return;
          const runtime = earnRuntime(c);
          const providerReferences = [...trustedByReference.keys()];
          const read = () => client.readVaultPositions(runtime, { owner, providerReferences });
          // The whole scoped read is shared, never the inner one: a joiner's
          // own minimum-slot scope would observe no RPC context and fail.
          const snapshots = await sharedVaultPositionRead(
            JSON.stringify([
              runtime.environment,
              rpcEndpointIdentity(c.env, earnClusterFor(runtime.environment)),
              provider,
              owner,
              [...providerReferences].sort(),
              minimumSlot ?? null,
            ]),
            options.rowsReadAt,
            hydrationDeadline,
            () => (minimumSlot === undefined ? read() : withMinimumRpcSlot(minimumSlot, read))
          );
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
              !isBoundedOptionalEpoch(snapshot.unlockTimestamp) ||
              !isBoundedOptionalIntermediate(snapshot.parIntermediate)
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
                ...(snapshot.parIntermediate ? { parIntermediate: snapshot.parIntermediate } : {}),
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
      // Provider messages may embed the owner, so an end-user owner is
      // scrubbed from them as well as from the fields.
      const redactedOwner = options.ownerKind === "external-wallet" ? job?.owner : undefined;
      getLogger().warn(
        {
          provider: job?.provider,
          ...(job ? ownerTelemetryFields(options.ownerKind, job.owner) : {}),
          positionCount: job?.positionCount,
          error: scrubLoggedText(
            result.reason instanceof Error ? result.reason.message : String(result.reason),
            redactedOwner
          ),
          causeChain: describeHydrationFailure(result.reason, redactedOwner),
        },
        "vault position: live hydration unavailable"
      );
    });
  }
  return live;
}

/** Bounds on the cause chain one hydration warning carries. */
const MAX_LOGGED_CAUSES = 16;
const MAX_LOGGED_CAUSE_DEPTH = 16;
const MAX_LOGGED_TEXT_LENGTH = 300;
// An RPC endpoint carries its API key in the path (Alchemy, Triton, QuickNode)
// or the query string (Helius), so a URL is dropped whole, as is a bare query.
const LOGGED_URL = /\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s"'<>]+/gi;
const LOGGED_QUERY = /\?[^\s"'<>=]*=[^\s"'<>]*/g;

/**
 * The rejection's cause tree, flattened depth-first into `name[code]: message`
 * lines, so the warning says WHY a value is unavailable. Providers wrap the
 * transport failure several layers deep and nest per-vault failures in an
 * `AggregateError`, none of which the top-level message shows.
 */
export function describeHydrationFailure(error: unknown, redactedOwner?: string): string[] {
  const chain: string[] = [];
  const seen = new Set<Error>();
  const visit = (node: unknown, depth: number): void => {
    if (chain.length >= MAX_LOGGED_CAUSES || depth > MAX_LOGGED_CAUSE_DEPTH) return;
    if (!(node instanceof Error)) {
      if (typeof node === "string") chain.push(scrubLoggedText(node, redactedOwner));
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    const code = (node as { code?: unknown }).code;
    const name =
      typeof code === "string" || typeof code === "number" ? `${node.name}[${code}]` : node.name;
    chain.push(scrubLoggedText(`${name}: ${node.message}`, redactedOwner));
    if (node instanceof AggregateError) {
      for (const member of node.errors) visit(member, depth + 1);
    }
    visit(node.cause, depth + 1);
  };
  visit(error, 0);
  return chain;
}

function scrubLoggedText(text: string, redactedOwner: string | undefined): string {
  // Redact the owner before clipping, so a cut cannot leave part of it behind.
  const anonymous = redactedOwner ? text.split(redactedOwner).join("[owner]") : text;
  const clipped =
    anonymous.length > MAX_LOGGED_TEXT_LENGTH
      ? `${anonymous.slice(0, MAX_LOGGED_TEXT_LENGTH)}...`
      : anonymous;
  return clipped.replace(LOGGED_URL, "[url]").replace(LOGGED_QUERY, "[query]");
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

function isBoundedOptionalIntermediate(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const intermediate = value as Partial<Record<keyof EarnVaultPositionIntermediate, unknown>>;
  return (
    typeof intermediate.mint === "string" &&
    isAddress(intermediate.mint) &&
    isBoundedSnapshotAmount(intermediate.amount) &&
    isBoundedSnapshotAmount(intermediate.withdrawableAmount) &&
    isBoundedSnapshotAmount(intermediate.tokenValue)
  );
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
  const empty = positions.filter((position) => {
    const value = live.get(position.id);
    return position.closedAt === null && value !== undefined && isEarnVaultHoldingEmpty(value);
  });
  const settled = await mapSettledWithConcurrency(empty, 8, (position) =>
    // `updatedAt` was read with the row, BEFORE the live balance: it is the
    // snapshot boundary the repository checks under the position lock.
    close(position.id, position.updatedAt)
  );
  settled.forEach((result, index) => {
    if (result.status !== "rejected") return;
    getLogger().warn(
      { positionId: empty[index]?.id, error: result.reason },
      "vault position close-out on read failed; the next read retries"
    );
  });
}
