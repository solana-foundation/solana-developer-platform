"use client";

import type {
  EarnVaultPosition,
  EarnWalletPosition,
  EarnWalletPositionSummary,
  EarnWalletTokenTotal,
} from "@sdp/types/earn";
import { isEarnVaultHoldingEmpty } from "@sdp/types/earn";
import type { EarnCoreStrategy } from "@sdp/types/earn-core";
import { earnBalanceReadContextSchema } from "@sdp/types/earn-wire";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import { earnCoreClient } from "@/lib/earn-core-data";
import { useCadencedSWR } from "@/lib/use-cadenced-swr";
import { earnQueryKeys } from "./earn-query-key";
import { earnVaultHoldingValue } from "./earn-vault-holding";

/** Strategy discovery and live positions shared by every Earn product. */
async function requestJson<T>(path: string): Promise<{ status: number; body: T | undefined }> {
  const response = await dashboardRequest(path, {});
  let body: T | undefined;
  try {
    body = (await response.json()) as T;
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/** A failed or malformed read cannot become a partial portfolio. */
async function requestJsonOk<T>(path: string): Promise<T> {
  const { status, body } = await requestJson<T>(path);
  if (status < 200 || status >= 300 || !body) {
    throw new Error(errorMessage(body, status));
  }
  return body;
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) return error.message;
  }
  return `Request failed (${status})`;
}

const LIVE_FEED_REFRESH_MS = 15_000;
const IDLE_REFRESH_MS = 120_000;
const EARN_PAGE_SIZE = 100;
const EARN_PAGE_LIMIT = 20;

/** Position values poll while holdings exist, with a calmer empty-state cadence. */
export function earnVaultPositionsRefreshInterval(
  read: EarnVaultPositionsRead | undefined
): number {
  return read?.positions.length === 0 ? IDLE_REFRESH_MS : LIVE_FEED_REFRESH_MS;
}

/**
 * Read the complete strategy catalogue for the shelf. Tables sort locally, so
 * every page is required before rendering catalogue totals or ordering.
 *
 * `cluster` is the PRO-1742 opt-in: omitted, the API answers the environment's
 * own shelf (the one a caller can act on); named, it browses that cluster's
 * sub-shelf — in practice the sandbox toggle reading the mirrored mainnet
 * catalogue, whose rows arrive `fundable: false`.
 */
export async function fetchEarnStrategies(cluster?: SolanaCluster): Promise<EarnCoreStrategy[]> {
  const strategies: EarnCoreStrategy[] = [];

  for (let page = 1; page <= EARN_PAGE_LIMIT; page += 1) {
    const discovery = await earnCoreClient.discovery({ page, pageSize: EARN_PAGE_SIZE, cluster });
    const body = { data: discovery };

    strategies.push(...body.data.strategies);
    if (strategies.length >= body.data.total) {
      return strategies;
    }
    if (body.data.strategies.length < EARN_PAGE_SIZE) {
      throw new Error("Earn strategies pagination ended before the reported total");
    }
  }

  throw new Error("Earn strategies pagination exceeded its safety limit");
}

export function useEarnStrategies(options?: { cluster?: SolanaCluster }) {
  const cluster = options?.cluster;
  // The cluster is part of the key: two views of different shelves must never
  // serve each other's cache entry, while the default view keeps deduping with
  // every other default caller.
  //
  // keepPreviousData → a cluster-toggle key flip keeps the current rows on
  // screen while the full paged fetch reruns, instead of tearing the table to
  // skeletons (same pattern as activity-tab and wallet-card-balance-value).
  //
  // No focus refetch: catalogue figures move only on the five-minute metrics
  // cron, so a focus would re-page the whole shelf for nothing new. A reload
  // or the page's own Refresh reads it again.
  const { data, error, isLoading, mutate } = useSWR(
    earnQueryKeys.strategies({ cluster: cluster ?? "environment-default" }),
    () => fetchEarnStrategies(cluster),
    { keepPreviousData: true, revalidateOnFocus: false }
  );
  return { strategies: data, error, isLoading, refresh: () => void mutate() };
}

/** The keyset page both live-position collections return. */
interface PositionPage<Position> {
  positions: Position[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * The cursor-paging loop every keyset-paged earn read shares. There is one
 * copy on purpose: the guard ladder here is what stops a bad server from
 * hurting the customer, and five drifting restatements of it had already
 * started to diverge.
 *
 * - The `seenCursors` guard turns a server that repeats or rewinds its cursor
 *   into a thrown error instead of a loop.
 * - A `hasMore` page shorter than the requested page size is refused the same
 *   way: a server that reports more rows than it returned in one page is
 *   contradicting itself, and the page-total readers already refuse that.
 * - The page-limit fallthrough throws rather than returning the prefix
 *   collected so far — a partial portfolio is worse than an error because it
 *   can hide money.
 */
async function fetchAllCursorPages<T>(input: {
  /** Names the collection in the thrown pagination errors. */
  subject: string;
  pageSize: number;
  fetchPage: (
    before: string | undefined
  ) => Promise<{ items: T[]; hasMore: boolean; nextCursor: string | null }>;
}): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;

  for (let page = 0; page < EARN_PAGE_LIMIT; page += 1) {
    const result = await input.fetchPage(before);
    items.push(...result.items);
    if (!result.hasMore) return items;

    const nextCursor = result.nextCursor;
    if (!nextCursor || nextCursor === before || seenCursors.has(nextCursor)) {
      throw new Error(`${input.subject} pagination did not advance`);
    }
    if (result.items.length < input.pageSize) {
      throw new Error(`${input.subject} pagination returned a short page while reporting more`);
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  // A partial portfolio is worse than an error because it can hide money.
  throw new Error(`${input.subject} pagination exceeded its safety limit`);
}

/**
 * Reads every page of one live-position collection over the shared cursor
 * pager.
 */
async function fetchAllPositionPages<Position>(
  path: (query: URLSearchParams) => string,
  subject: string,
  afterMovementIds: readonly string[] = [],
  observeMinimumSlot?: (slot: number) => void
): Promise<Position[]> {
  return fetchAllCursorPages<Position>({
    subject,
    pageSize: EARN_PAGE_SIZE,
    async fetchPage(before) {
      const query = new URLSearchParams({ limit: String(EARN_PAGE_SIZE) });
      if (before) query.set("before", before);
      if (afterMovementIds.length > 0) query.set("afterMovementIds", afterMovementIds.join(","));

      const body = await requestJsonOk<{
        data: PositionPage<Position> & { balanceReadContext?: unknown };
      }>(path(query));
      if (afterMovementIds.length > 0) {
        const context = earnBalanceReadContextSchema.safeParse(body.data.balanceReadContext);
        const acknowledgedMovements = new Set(context.success ? context.data.afterMovementIds : []);
        if (!context.success || afterMovementIds.some((id) => !acknowledgedMovements.has(id))) {
          throw new Error("Vault position read did not establish confirmation freshness");
        }
        observeMinimumSlot?.(context.data.minimumSlot);
      }
      return {
        items: body.data.positions,
        hasMore: body.data.hasMore,
        nextCursor: body.data.nextCursor,
      };
    },
  });
}

/**
 * Reads every vault position held by the selected project. The API uses an
 * opaque keyset cursor and hydrates balances live from chain, so cursor
 * progression — not row count — decides when the read is complete.
 */
export async function fetchEarnVaultPositions(
  afterMovementIds: readonly string[] = [],
  observeMinimumSlot?: (slot: number) => void
): Promise<EarnVaultPosition[]> {
  const positions = await fetchAllPositionPages<import("@sdp/types/earn-core").EarnCorePosition>(
    (query) => `/api/dashboard/markets/earn/positions?sourceType=wallet&${query}`,
    "Vault positions",
    afterMovementIds,
    observeMinimumSlot
  );
  return positions.map((position) => {
    if (!("walletId" in position.source)) throw new Error("Invalid custody position identity");
    if (position.createdAt === null) throw new Error("Unexpected untracked custody position");
    return {
      ...position,
      createdAt: position.createdAt,
      custodyWalletId: position.source.walletId,
    };
  });
}

/** A positions snapshot and client read times, used to refresh after confirmation. */
export interface EarnVaultPositionsRead {
  positions: EarnVaultPosition[];
  startedAt: number;
  landedAt: number;
  afterMovementIds?: readonly string[];
  minimumSlot?: number;
  minimumSlotsByPositionId?: ReadonlyMap<string, number>;
  minimumSlotMovementIdsByPositionId?: ReadonlyMap<string, string>;
}

/**
 * Keep each position's evidence together. A position with more than 100
 * movements gets its own batches, so their minimum slots can be compared
 * without borrowing the slot of an unrelated position.
 */
function vaultBalanceReadBatches(
  movementIds: readonly string[],
  positionIds?: ReadonlyMap<string, string>
): string[][] {
  if (movementIds.length <= 100) return [[...movementIds]];
  const byPosition = new Map<string, string[]>();
  for (const id of movementIds) {
    const positionId = positionIds?.get(id);
    if (!positionId) throw new Error("Missing position for batched balance verification");
    const group = byPosition.get(positionId) ?? [];
    group.push(id);
    byPosition.set(positionId, group);
  }
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const group of byPosition.values()) {
    if (batch.length + group.length > 100) {
      if (batch.length > 0) batches.push(batch);
      batch = [];
    }
    if (group.length > 100) {
      for (let index = 0; index < group.length; index += 100)
        batches.push(group.slice(index, index + 100));
    } else batch.push(...group);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** At most two portfolio reads at once, even after a prolonged outage. */
async function readVaultBalanceBatches(batches: readonly string[][]) {
  const results: { batch: string[]; positions: EarnVaultPosition[]; minimumSlot?: number }[] = [];
  let next = 0;
  let stopped = false;
  async function readNext(): Promise<void> {
    if (stopped) return;
    const index = next++;
    const batch = batches[index];
    if (!batch) return;
    try {
      let minimumSlot: number | undefined;
      const positions = await fetchEarnVaultPositions(batch, (slot) => {
        minimumSlot = Math.max(minimumSlot ?? 0, slot);
      });
      results[index] = { batch, positions, minimumSlot };
      return readNext();
    } catch (error) {
      stopped = true;
      throw error;
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, () => readNext()));
  return results;
}

export async function readEarnVaultPositions(
  afterMovementIds: readonly string[] = [],
  positionIds?: ReadonlyMap<string, string>
): Promise<EarnVaultPositionsRead> {
  const startedAt = Date.now();
  const batches = vaultBalanceReadBatches(afterMovementIds, positionIds);
  const verified = new Map<string, { position: EarnVaultPosition | undefined; slot: number }>();
  let positions: EarnVaultPosition[] = [];
  let minimumSlot: number | undefined;
  const reads = await readVaultBalanceBatches(batches);
  for (const { batch, positions: batchPositions, minimumSlot: batchSlot } of reads) {
    positions = batchPositions;
    if (batchSlot !== undefined) minimumSlot = Math.max(minimumSlot ?? 0, batchSlot);
    if (batches.length > 1) {
      const byId = new Map(positions.map((position) => [position.id, position]));
      for (const id of batch) {
        const positionId = positionIds?.get(id);
        if (!positionId || batchSlot === undefined)
          throw new Error("Missing position balance verification");
        // Multiple batches for one position must use the greatest proven slot,
        // even when confirmation arrival order differs from chain slot order.
        if ((verified.get(positionId)?.slot ?? -1) <= batchSlot)
          verified.set(positionId, { position: byId.get(positionId), slot: batchSlot });
      }
    }
  }
  if (batches.length > 1) {
    const combined = new Map(positions.map((position) => [position.id, position]));
    for (const [id, { position }] of verified) {
      if (position) combined.set(id, position);
      else combined.delete(id);
    }
    positions = [...combined.values()];
  }
  return { positions, startedAt, landedAt: Date.now(), afterMovementIds, minimumSlot };
}

/** Read only changed positions, preserving the same movement and slot checks as a full read. */
async function readTargetedVaultPositions(
  afterMovementIds: readonly string[],
  positionIds: ReadonlyMap<string, string>
): Promise<EarnVaultPositionsRead> {
  const startedAt = Date.now();
  const groups = new Map<string, string[]>();
  for (const movementId of afterMovementIds) {
    const positionId = positionIds.get(movementId);
    if (!positionId) throw new Error("Missing position for balance verification");
    const ids = groups.get(positionId) ?? [];
    ids.push(movementId);
    groups.set(positionId, ids);
  }
  const pending = [...groups];
  const positions: EarnVaultPosition[] = [];
  const minimumSlotsByPositionId = new Map<string, number>();
  const minimumSlotMovementIdsByPositionId = new Map<string, string>();
  let minimumSlot: number | undefined;
  let next = 0;
  let stopped = false;
  async function readNext(): Promise<void> {
    while (!stopped && next < pending.length) {
      const group = pending[next++];
      if (!group) return;
      const [positionId, ids] = group;
      let strongest: import("@sdp/types/earn-core").EarnCorePosition | undefined;
      let strongestSlot = -1;
      let strongestMovementId: string | undefined;
      for (let index = 0; !stopped && index < ids.length; index += 100) {
        const batch = ids.slice(index, index + 100);
        const position = await earnCoreClient.position(positionId, {
          afterMovementIds: batch.join(","),
        });
        const context = earnBalanceReadContextSchema.parse(position.balanceReadContext);
        const acknowledged = new Set(context.afterMovementIds);
        if (
          batch.some((id) => !acknowledged.has(id)) ||
          context.minimumSlotMovementId === undefined ||
          !batch.includes(context.minimumSlotMovementId)
        )
          throw new Error("Position read did not establish confirmation freshness");
        if (context.minimumSlot >= strongestSlot) {
          strongest = position;
          strongestSlot = context.minimumSlot;
          strongestMovementId = context.minimumSlotMovementId;
        }
      }
      if (
        !strongest ||
        !strongestMovementId ||
        !("walletId" in strongest.source) ||
        strongest.createdAt === null
      )
        throw new Error("Invalid custody position identity");
      minimumSlot = Math.max(minimumSlot ?? 0, strongestSlot);
      minimumSlotsByPositionId.set(positionId, strongestSlot);
      minimumSlotMovementIdsByPositionId.set(positionId, strongestMovementId);
      const position = {
        ...strongest,
        createdAt: strongest.createdAt,
        custodyWalletId: strongest.source.walletId,
      };
      if (
        !isVerifiedClosedPosition(position) &&
        (position.shares === undefined || earnVaultHoldingValue(position) === undefined)
      )
        throw new Error("Position balance is unavailable after the operation");
      positions.push(position);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(2, pending.length) }, async () => {
      try {
        await readNext();
      } catch (error) {
        stopped = true;
        throw error;
      }
    })
  );
  return {
    positions,
    afterMovementIds,
    minimumSlot,
    minimumSlotsByPositionId,
    minimumSlotMovementIdsByPositionId,
    startedAt,
    landedAt: Date.now(),
  };
}

/** Retain one last verified value per current position, plus the newest raw read. */
export function appendVaultPositionsRead(
  reads: readonly EarnVaultPositionsRead[],
  read: EarnVaultPositionsRead
): readonly EarnVaultPositionsRead[] {
  if (reads[reads.length - 1] === read) return reads;
  const missing = new Set(
    read.positions
      .filter((position) => earnVaultHoldingValue(position) === undefined)
      .map(({ id }) => id)
  );
  const retained: EarnVaultPositionsRead[] = [];
  for (let index = reads.length - 1; index >= 0 && missing.size > 0; index -= 1) {
    const previous = reads[index];
    if (!previous) continue;
    const positions = previous.positions.filter((position) => {
      if (!missing.has(position.id) || earnVaultHoldingValue(position) === undefined) return false;
      missing.delete(position.id);
      return true;
    });
    if (positions.length > 0) retained.unshift({ ...previous, positions });
  }
  return [...retained, read];
}

function vaultPositionsReadKey(
  afterMovementIds: readonly string[],
  positionIds: ReadonlyMap<string, string> | undefined
): string {
  return JSON.stringify(afterMovementIds.map((id) => [id, positionIds?.get(id) ?? null]));
}

function isVerifiedClosedPosition(position: EarnVaultPosition): boolean {
  return (
    position.closedAt !== null &&
    position.shares !== undefined &&
    isEarnVaultHoldingEmpty({
      shares: position.shares,
      parIntermediate: position.parIntermediate,
    })
  );
}

function retainedMinimumSlot(read: EarnVaultPositionsRead, observed: ReadonlyMap<string, number>) {
  let minimumSlot = read.minimumSlot;
  for (const { id } of read.positions) {
    const previous = observed.get(id);
    if (previous !== undefined) minimumSlot = Math.max(minimumSlot ?? 0, previous);
  }
  return minimumSlot;
}

/**
 * Live position values refresh while the surface is mounted, idling while none exists
 * (`earnVaultPositionsRefreshInterval`); `reads` keeps the recent history, newest last. The poll
 * and explicit refreshes share one in-flight read when their requests are identical.
 */
export function useEarnVaultPositions() {
  const afterMovementIds = useRef<readonly string[]>([]);
  const movementPositionIds = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  const inFlight = useRef(new Map<string, Promise<EarnVaultPositionsRead>>());
  const version = useRef(0);
  const latest = useRef<EarnVaultPositionsRead | undefined>(undefined);
  const observedVersions = useRef(new Map<string, number>());
  const observedSlots = useRef(new Map<string, number>());
  const strongestProofs = useRef(new Map<string, { movementId: string; slot: number }>());
  const outstandingProofs = useRef(new Map<string, string>());
  const closed = useRef(new Set<string>());
  const merge = useCallback(
    (incoming: EarnVaultPositionsRead, readVersion: number, targeted: boolean) => {
      const positions = new Map(
        (targeted ? (latest.current?.positions ?? []) : incoming.positions).map((position) => [
          position.id,
          position,
        ])
      );
      // A late collection read cannot erase a newly observed deposit or replace its value.
      for (const position of latest.current?.positions ?? []) {
        if ((observedVersions.current.get(position.id) ?? -1) > readVersion)
          positions.set(position.id, position);
      }
      for (const id of closed.current) {
        if ((observedVersions.current.get(id) ?? -1) > readVersion) positions.delete(id);
      }
      const minimumSlot = retainedMinimumSlot(incoming, observedSlots.current);
      for (const position of incoming.positions) {
        const previousSlot = observedSlots.current.get(position.id);
        if ((observedVersions.current.get(position.id) ?? -1) > readVersion) continue;
        if (isVerifiedClosedPosition(position)) {
          positions.delete(position.id);
          closed.current.add(position.id);
        } else {
          positions.set(position.id, position);
          closed.current.delete(position.id);
        }
        observedVersions.current.set(position.id, readVersion);
        const slot = incoming.minimumSlotsByPositionId?.get(position.id);
        if (slot !== undefined)
          observedSlots.current.set(position.id, Math.max(previousSlot ?? 0, slot));
      }
      const merged = { ...incoming, minimumSlot, positions: [...positions.values()] };
      latest.current = merged;
      return merged;
    },
    []
  );
  const retainProofs = useCallback((incoming: EarnVaultPositionsRead) => {
    for (const [positionId, movementId] of incoming.minimumSlotMovementIdsByPositionId ?? []) {
      const slot = incoming.minimumSlotsByPositionId?.get(positionId);
      if (slot === undefined) throw new Error("Missing position observation slot");
      const previous = strongestProofs.current.get(positionId);
      if (previous === undefined || slot >= previous.slot)
        strongestProofs.current.set(positionId, { movementId, slot });
      for (const id of incoming.afterMovementIds ?? []) {
        if (outstandingProofs.current.get(id) === positionId) outstandingProofs.current.delete(id);
      }
    }
    const retained = new Map(outstandingProofs.current);
    for (const [positionId, proof] of strongestProofs.current)
      retained.set(proof.movementId, positionId);
    movementPositionIds.current = retained;
    afterMovementIds.current = [...retained.keys()];
  }, []);
  const read = useCallback(() => {
    const ids = afterMovementIds.current;
    const positionIds = movementPositionIds.current;
    const key = vaultPositionsReadKey(ids, positionIds);
    const running = inFlight.current.get(key);
    if (running) return running;
    const readVersion = ++version.current;
    const started = readEarnVaultPositions(ids, positionIds).then((incoming) =>
      merge(incoming, readVersion, false)
    );
    const settle = () => {
      if (inFlight.current.get(key) === started) inFlight.current.delete(key);
    };
    inFlight.current.set(key, started);
    started.then(settle, settle);
    return started;
  }, [merge]);
  const { data, error, isLoading, mutate } = useCadencedSWR(
    earnQueryKeys.vaultPositions(),
    read,
    earnVaultPositionsRefreshInterval
  );
  const [history, setHistory] = useState<readonly EarnVaultPositionsRead[]>([]);
  useEffect(() => {
    if (data) {
      if (latest.current === undefined) latest.current = data;
      setHistory((current) => appendVaultPositionsRead(current, data));
    }
  }, [data]);
  // The history state lands one render late; fold the newest read in directly.
  const reads = useMemo(
    () => (data ? appendVaultPositionsRead(history, data) : history),
    [data, history]
  );
  const refresh = useCallback(
    (movementIds?: readonly string[], positionIds?: ReadonlyMap<string, string>) => {
      if (movementIds && positionIds && movementIds.length > 0) {
        const retained = new Map(movementPositionIds.current);
        for (const [id, positionId] of positionIds) {
          retained.set(id, positionId);
          outstandingProofs.current.set(id, positionId);
        }
        movementPositionIds.current = retained;
        afterMovementIds.current = [...new Set([...afterMovementIds.current, ...movementIds])];
        // A detail response cannot establish the rest of an uninitialized portfolio.
        if (latest.current === undefined)
          return mutate(read(), { revalidate: false, throwOnError: true }).catch(async (cause) => {
            await mutate();
            throw cause;
          });
        const targets = new Set(movementIds.map((id) => positionIds.get(id)));
        const proofIds = afterMovementIds.current.filter((id) => targets.has(retained.get(id)));
        const key = `targeted:${vaultPositionsReadKey(proofIds, retained)}`;
        let started = inFlight.current.get(key);
        if (!started) {
          const readVersion = ++version.current;
          started = readTargetedVaultPositions(proofIds, retained).then((incoming) => {
            const merged = merge(incoming, readVersion, true);
            retainProofs(incoming);
            return merged;
          });
          const settle = () => inFlight.current.delete(key);
          inFlight.current.set(key, started);
          started.then(settle, settle);
        }
        return mutate(started, { revalidate: false, throwOnError: true });
      }
      if (movementIds) {
        afterMovementIds.current = [...movementIds];
        movementPositionIds.current = positionIds;
      }
      // Explicit mutation propagates failures; a bare SWR revalidation can
      // resolve with cached data after its fetcher failed.
      return mutate(read(), { revalidate: false, throwOnError: true });
    },
    [mutate, read, merge, retainProofs]
  );
  return { positions: data?.positions, reads, error, isLoading, refresh };
}

/**
 * Reads every live position for exactly one partner end-user wallet.
 * Kept at the strict dashboard boundary for the planned wallet drill-down.
 */
export async function fetchEarnWalletPositions(
  ownerAddress: string
): Promise<Array<Omit<EarnWalletPosition, "createdAt"> & { createdAt: string | null }>> {
  const positions = await fetchAllPositionPages<import("@sdp/types/earn-core").EarnCorePosition>(
    (query) =>
      `/api/dashboard/markets/earn/positions?sourceType=address&ownerAddress=${encodeURIComponent(ownerAddress)}&discover=true&${query}`,
    "Wallet positions"
  );
  return positions.map((position) => {
    if (!("ownerAddress" in position.source) || position.source.ownerAddress !== ownerAddress) {
      throw new Error("Invalid owner-address position identity");
    }
    return {
      ...position,
      createdAt: position.createdAt,
      ownerAddress: position.source.ownerAddress,
    };
  });
}

/** One per-token aggregate; `tokenValue` is absent when any position is unavailable. */
const earnWalletTokenTotalSchema: z.ZodType<EarnWalletTokenTotal> = z.object({
  tokenMint: z.string(),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  unavailablePositionCount: z.number().int().nonnegative(),
  /** Sum of the positions' `tokenValue` in `tokenMint`, a dollar figure at par; absent when any position is unavailable. */
  tokenValue: z.string().optional(),
});

const earnWalletPositionRecordSchema: z.ZodType<EarnWalletPosition> = z.object({
  id: z.string(),
  ownerAddress: z.string(),
  provider: z.string(),
  providerReference: z.string(),
  label: z.string(),
  tokenMint: z.string(),
  shareMint: z.string(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  /** Absent when the live provider read failed; unavailable is never encoded as zero. */
  shares: z.string().optional(),
  withdrawableShares: z.string().optional(),
  unlockTimestamp: z.string().nullable().optional(),
  /** Provider-reported value in `tokenMint` (rate or exit quote), a dollar figure at par; never a share count. */
  tokenValue: z.string().optional(),
  parIntermediate: z
    .object({
      mint: z.string(),
      amount: z.string(),
      withdrawableAmount: z.string(),
      tokenValue: z.string(),
    })
    .optional(),
});

/**
 * The per-customer portfolio summary, checked at the boundary like every other
 * seam in this file — the type assert this replaced declared a shape it never
 * looked at, so a malformed envelope (an older API, a drifted contract) would
 * reach the Embedded Yield dashboard's render path and crash it on a
 * non-array `totalsByStrategy` or mis-derive the onboarding/portfolio split
 * from unvalidated counts.
 */
const earnWalletPositionSummarySchema: z.ZodType<EarnWalletPositionSummary> = z.object({
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  unavailablePositionCount: z.number().int().nonnegative(),
  totalsByStrategy: z.array(
    z.object({
      provider: z.string(),
      providerReference: z.string(),
      label: z.string(),
      ownerAddresses: z.array(z.string()).optional(),
      positions: z.array(earnWalletPositionRecordSchema).optional(),
      walletCount: z.number().int().nonnegative(),
      positionCount: z.number().int().nonnegative(),
      totalsByToken: z.array(earnWalletTokenTotalSchema),
    })
  ),
  totalsByToken: z.array(earnWalletTokenTotalSchema),
});

export async function fetchEarnWalletPositionSummary(): Promise<EarnWalletPositionSummary> {
  const response = await earnCoreClient.positions({
    sourceType: "address",
    includeSummary: true,
    includeOwnerAddresses: true,
    includePositions: true,
    limit: 1,
  });
  if (!response.summary) throw new Error("Missing wallet position summary");
  return earnWalletPositionSummarySchema.parse(response.summary);
}

export function earnWalletSummaryRefreshInterval(
  detailsVisible: boolean,
  environment = process.env.NODE_ENV
): number {
  if (environment === "development") return 3_000;
  return detailsVisible ? 15_000 : 60_000;
}

/** Live customer portfolio totals refresh while the Embedded Yield dashboard is mounted. */
export function useEarnWalletPositionSummary({
  detailsVisible = false,
}: {
  detailsVisible?: boolean;
} = {}) {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-wallet-position-summary",
    () => fetchEarnWalletPositionSummary(),
    {
      refreshInterval: earnWalletSummaryRefreshInterval(detailsVisible),
    }
  );
  return {
    summary: data,
    error,
    isInitialLoading: isLoading && data === undefined,
    refresh: () => void mutate(),
  };
}
