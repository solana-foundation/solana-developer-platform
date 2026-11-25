"use client";

import { useCallback, useEffect } from "react";
import useSWR, { type Cache, unstable_serialize, useSWRConfig } from "swr";
import { z } from "zod";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { dashboardRequest } from "@/lib/dashboard-fetch";

/**
 * Funding wallets for the deposit flow: the org's own SDP wallets, plus the
 * display helpers every surface that names one needs.
 *
 * An SDP wallet is the funding source, never the Earn product itself. For a
 * custodial program the operator transfers funds to the provider's address, so
 * the choice shapes instructions only. For a `vault_direct` deposit the chosen
 * custody-wallet row is sent to the API because that wallet signs the on-chain
 * deposit and holds the resulting shares. One live wallet inventory serves
 * both flows; their write contracts remain deliberately separate.
 */

const walletTokenBalanceSchema = z.object({
  token: z.string(),
  mint: z.string(),
  amount: z.string(),
  uiAmount: z.string(),
  decimals: z.number(),
  usdPrice: z.number().optional(),
  usdValue: z.number().optional(),
});

/**
 * The wallet fields this seam actually promises its callers, PARSED rather than
 * asserted.
 *
 * The envelope walk this replaced proved only that `data.wallets` was an array
 * and then cast the rows to the full custody type — so a response missing
 * `publicKey` (the address a deposit is signed from) type-checked as a complete
 * wallet and failed later, somewhere else. Parsing here means a malformed row
 * fails loudly at the boundary that read it. The row type is derived from this
 * schema, so the two cannot drift.
 */
const earnFundingWalletSchema = z.object({
  id: z.string(),
  walletId: z.string(),
  publicKey: z.string(),
  /**
   * Custody provider name, for display only. Optional and deliberately not an
   * enum: it labels a badge, and a provider id this build has not heard of must
   * not fail the row and disable deposits over a caption.
   */
  provider: z.string().optional(),
  label: z.string().nullable(),
  purpose: z.string().nullable(),
  status: z.enum(["active", "inactive"]),
  isRuntimeExecutionAllowed: z.boolean(),
  custodyConfigId: z.string().optional(),
  custodyConnectionId: z.string().optional(),
  balances: z.array(walletTokenBalanceSchema).optional(),
});

/**
 * An invalid success envelope is an upstream failure, not an empty wallet list.
 * Treating it as `[]` would disable deposits while claiming the org simply has
 * no wallets.
 */
const fundingWalletsResponseSchema = z.object({
  data: z.object({
    wallets: z.array(earnFundingWalletSchema),
  }),
});

const fundingWalletBalanceResponseSchema = z.object({
  data: z.object({
    balanceReadContext: z
      .object({ minimumSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .optional(),
    walletBalances: z.object({
      balances: z.array(walletTokenBalanceSchema),
    }),
  }),
});

export type EarnFundingWallet = z.infer<typeof earnFundingWalletSchema>;

/**
 * Balances come from live RPC reads, so they are opt-in per request and served
 * from short-TTL caches on both sides. They are shown as context only — never
 * as a gate on what the user may deposit.
 */
const WALLETS_PATH = "/api/dashboard/wallets?view=summary&includeBalances=true";

export async function fetchFundingWallets(): Promise<EarnFundingWallet[]> {
  const response = await dashboardRequest(WALLETS_PATH, {});
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const parsed = fundingWalletsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Invalid custody wallet response");
  }
  // Only usable funding sources: an inactive wallet cannot originate a transfer.
  return parsed.data.data.wallets.filter((wallet) => wallet.status === "active");
}

/**
 * Read one wallet directly from the uncached Payments balance endpoint.
 *
 * The collection endpoint intentionally keeps a short API-side cache for
 * normal dashboard reads. That cache is the wrong source immediately after a
 * vault movement settles: both the submit refresh and the settlement refresh
 * can otherwise land inside the same cache window and leave Treasury frozen
 * on the pre-transaction balance.
 */
export async function fetchLiveFundingWalletBalance(
  walletId: string,
  minimumSlot?: number
): Promise<NonNullable<EarnFundingWallet["balances"]>> {
  const query = minimumSlot === undefined ? "" : `?minimumSlot=${minimumSlot}`;
  const response = await dashboardRequest(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances${query}`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const parsed = fundingWalletBalanceResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Invalid custody wallet balance response");
  }
  if (
    minimumSlot !== undefined &&
    (parsed.data.data.balanceReadContext?.minimumSlot ?? -1) < minimumSlot
  ) {
    throw new Error("Wallet balance read did not establish confirmation freshness");
  }
  return parsed.data.data.walletBalances.balances;
}

/**
 * Refresh the requested wallets and every binding of their chain addresses.
 * A complete snapshot refresh omits the ids. Reject a failed selected read so
 * Treasury cannot publish the position side without its verified cash side.
 */
export async function refreshFundingWalletBalances(
  wallets: readonly EarnFundingWallet[],
  minimumSlot?: number | ReadonlyMap<string, number>,
  custodyWalletIds?: readonly string[]
): Promise<EarnFundingWallet[]> {
  const addresses = fundingWalletAddresses(wallets, custodyWalletIds);
  const slotsByAddress = fundingWalletSlotsByAddress(wallets, minimumSlot);
  const reads = new Map<string, ReturnType<typeof fetchLiveFundingWalletBalance>>();
  return Promise.all(
    wallets.map(async (wallet) => {
      if (!addresses.has(wallet.publicKey)) return wallet;
      let read = reads.get(wallet.publicKey);
      if (read === undefined) {
        const slot = slotsByAddress.get(wallet.publicKey);
        read = fetchLiveFundingWalletBalance(wallet.walletId, slot);
        reads.set(wallet.publicKey, read);
      }
      return { ...wallet, balances: await read };
    })
  );
}

function fundingWalletAddresses(
  wallets: readonly EarnFundingWallet[],
  custodyWalletIds: readonly string[] | undefined
): ReadonlySet<string> {
  if (custodyWalletIds === undefined) return new Set(wallets.map((wallet) => wallet.publicKey));
  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  return new Set(
    custodyWalletIds.map((id) => {
      const wallet = byId.get(id);
      if (wallet === undefined) throw new Error("Confirmed movement wallet is not available");
      return wallet.publicKey;
    })
  );
}

function fundingWalletSlotsByAddress(
  wallets: readonly EarnFundingWallet[],
  minimumSlot: number | ReadonlyMap<string, number> | undefined
): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  for (const wallet of wallets) {
    const slot = typeof minimumSlot === "number" ? minimumSlot : minimumSlot?.get(wallet.id);
    if (slot !== undefined)
      slots.set(wallet.publicKey, Math.max(slots.get(wallet.publicKey) ?? 0, slot));
  }
  return slots;
}

interface FundingWalletObservation {
  version: number;
  minimumSlot: number | undefined;
}

interface FundingWalletSnapshot {
  inventoryVersion: number;
  wallets: EarnFundingWallet[];
  observations: ReadonlyMap<string, FundingWalletObservation>;
}

interface FundingWalletRead {
  wallets: EarnFundingWallet[];
  addresses: ReadonlySet<string>;
  minimumSlots: ReadonlyMap<string, number>;
  version: number;
  targeted: boolean;
  reusedInventory: boolean;
}

interface FundingWalletRefreshCoordinator {
  consumers: number;
  requireLiveBalances: boolean;
  minimumSlot: number | undefined;
  walletMinimumSlots: Map<string, number>;
  inFlight: Map<string, Promise<FundingWalletRead>>;
  version: number;
}

// The dashboard replaces its provider on session, organization or project changes.
// Share coordination between its Treasury and dialog consumers, never across scopes.
const fundingWalletCoordinators = new WeakMap<
  Cache,
  Map<string, FundingWalletRefreshCoordinator>
>();

function fundingWalletCoordinator(cache: Cache, key: string): FundingWalletRefreshCoordinator {
  let coordinators = fundingWalletCoordinators.get(cache);
  if (coordinators === undefined) {
    coordinators = new Map();
    fundingWalletCoordinators.set(cache, coordinators);
  }
  let coordinator = coordinators.get(key);
  if (coordinator === undefined) {
    coordinator = {
      consumers: 0,
      requireLiveBalances: false,
      minimumSlot: undefined,
      walletMinimumSlots: new Map(),
      inFlight: new Map(),
      version: 0,
    };
    coordinators.set(key, coordinator);
  }
  return coordinator;
}

/** Merge only verified observations, retaining newer reads from any mounted consumer. */
function mergeFundingWalletRead(
  current: FundingWalletSnapshot | undefined,
  read: FundingWalletRead,
  coordinator: FundingWalletRefreshCoordinator
): FundingWalletSnapshot {
  if (read.reusedInventory && current === undefined)
    throw new Error("Wallet inventory changed while refreshing balances");
  const keepInventory =
    current !== undefined && (read.reusedInventory || current.inventoryVersion > read.version);
  const inventory = keepInventory ? current.wallets : read.wallets;
  const previousByAddress = new Map(current?.wallets.map((wallet) => [wallet.publicKey, wallet]));
  const incomingByAddress = new Map(read.wallets.map((wallet) => [wallet.publicKey, wallet]));
  const requiredSlots = fundingWalletSlotsByAddress(
    inventory,
    coordinator.minimumSlot ?? coordinator.walletMinimumSlots
  );
  const inventoryAddresses = new Set(inventory.map((wallet) => wallet.publicKey));
  if (read.targeted && [...read.addresses].some((address) => !inventoryAddresses.has(address)))
    throw new Error("Wallet inventory changed while refreshing balances");
  const observations = new Map(
    [...(current?.observations ?? [])].filter(([address]) => inventoryAddresses.has(address))
  );
  const wallets = inventory.map((wallet) => {
    const address = wallet.publicKey;
    const previous = previousByAddress.get(address);
    if (!read.addresses.has(address))
      return previous === undefined ? wallet : { ...wallet, balances: previous.balances };
    const observation = current?.observations.get(address);
    const requiredSlot = requiredSlots.get(address) ?? 0;
    if (
      previous !== undefined &&
      observation !== undefined &&
      observation.version > read.version &&
      (observation.minimumSlot ?? 0) >= requiredSlot
    )
      return { ...wallet, balances: previous.balances };
    const minimumSlot = read.minimumSlots.get(address);
    if ((minimumSlot ?? 0) < requiredSlot)
      throw new Error("A newer wallet balance confirmation is pending");
    const incoming = incomingByAddress.get(address);
    if (incoming === undefined) throw new Error("Refreshed wallet balance is missing");
    observations.set(address, { version: read.version, minimumSlot });
    return { ...wallet, balances: incoming.balances };
  });
  return {
    wallets,
    observations,
    inventoryVersion: keepInventory ? current.inventoryVersion : read.version,
  };
}

/** Identical sweeps share live reads; a movement reuses the current wallet inventory. */
export function useEarnFundingWallets() {
  const { cache } = useSWRConfig();
  const key = earnQueryKeys.fundingWallets();
  const coordinator = fundingWalletCoordinator(cache, unstable_serialize(key));
  useEffect(() => {
    coordinator.consumers += 1;
    return () => {
      coordinator.consumers -= 1;
    };
  }, [coordinator]);
  const sweep = useCallback(
    (
      readLive: boolean,
      knownWallets?: readonly EarnFundingWallet[],
      custodyWalletIds?: readonly string[]
    ): Promise<FundingWalletRead> => {
      const floor = coordinator.minimumSlot;
      const floors = new Map(coordinator.walletMinimumSlots);
      const live =
        readLive || coordinator.requireLiveBalances || floor !== undefined || floors.size > 0;
      const requestKey = JSON.stringify([
        live,
        custodyWalletIds === undefined ? null : [...custodyWalletIds].sort(),
        floor ?? null,
        [...floors].sort(([left], [right]) => left.localeCompare(right)),
      ]);
      const running = coordinator.inFlight.get(requestKey);
      if (running !== undefined) return running;
      const version = ++coordinator.version;
      const started = (async (): Promise<FundingWalletRead> => {
        const knownIds = new Set(knownWallets?.map((wallet) => wallet.id));
        const reusedInventory =
          custodyWalletIds !== undefined &&
          knownWallets !== undefined &&
          custodyWalletIds.every((id) => knownIds.has(id));
        const inventory =
          reusedInventory && knownWallets !== undefined
            ? knownWallets
            : await fetchFundingWallets();
        const wallets = live
          ? await refreshFundingWalletBalances(inventory, floor ?? floors, custodyWalletIds)
          : [...inventory];
        return {
          wallets,
          addresses: fundingWalletAddresses(wallets, custodyWalletIds),
          minimumSlots: fundingWalletSlotsByAddress(wallets, floor ?? floors),
          version,
          targeted: custodyWalletIds !== undefined,
          reusedInventory,
        };
      })();
      const settle = () => {
        if (coordinator.inFlight.get(requestKey) === started)
          coordinator.inFlight.delete(requestKey);
      };
      coordinator.inFlight.set(requestKey, started);
      started.then(settle, settle);
      return started;
    },
    [coordinator]
  );
  const { data, error, isLoading, mutate } = useSWR(key, async () =>
    mergeFundingWalletRead(undefined, await sweep(false), coordinator)
  );
  const refreshBalances = useCallback(
    async (slot?: number, custodyWalletIds?: readonly string[]) => {
      if (coordinator.consumers === 0) return undefined;
      // Later inventory reads must not replace live observations with cached cash.
      coordinator.requireLiveBalances = true;
      if (slot !== undefined) {
        if (custodyWalletIds && coordinator.minimumSlot === undefined) {
          for (const id of custodyWalletIds)
            coordinator.walletMinimumSlots.set(
              id,
              Math.max(coordinator.walletMinimumSlots.get(id) ?? 0, slot)
            );
        } else {
          coordinator.minimumSlot = Math.max(
            coordinator.minimumSlot ?? 0,
            slot,
            ...coordinator.walletMinimumSlots.values()
          );
        }
      }
      // Consumers can unmount during this shared read, so recheck after it settles.
      // react-doctor-disable-next-line async-defer-await
      const read = await sweep(true, data?.wallets, custodyWalletIds);
      // A replaced project/organization provider has no cache left to update.
      if (coordinator.consumers === 0) return undefined;
      // Merge at completion so concurrent consumers preserve each other's wallets.
      const published = await mutate(
        (current) => mergeFundingWalletRead(current, read, coordinator),
        {
          revalidate: false,
          throwOnError: true,
        }
      );
      return published?.wallets;
    },
    [coordinator, data?.wallets, mutate, sweep]
  );
  return {
    wallets: data?.wallets,
    error,
    isLoading,
    refresh: () => void mutate(),
    refreshBalances,
  };
}

// --- Display helpers -------------------------------------------------------

/**
 * What to call a wallet on screen. THE single source for this: a wallet label is
 * user-set and nullable, and `||` (not `??`) is required so a label of spaces
 * falls back instead of rendering an empty name.
 */
export function walletDisplayName(wallet: EarnFundingWallet | undefined, fallback: string): string {
  return wallet?.label?.trim() || fallback;
}
