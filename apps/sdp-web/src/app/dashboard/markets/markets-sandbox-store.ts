"use client";

import type { DvpTradeSide } from "@sdp/types";
import { useCallback, useSyncExternalStore } from "react";
import type { DvpTrade } from "./dvp/dvp-trade";

export const MARKETS_SANDBOX_TOKEN_SYMBOLS = ["SOL", "USDC", "USDG", "USDT", "PYUSD"] as const;
export type MarketsSandboxTokenSymbol = (typeof MARKETS_SANDBOX_TOKEN_SYMBOLS)[number];

export const MARKETS_SANDBOX_STABLE_SYMBOLS = ["USDC", "USDG", "USDT", "PYUSD"] as const;
export type MarketsSandboxStableSymbol = (typeof MARKETS_SANDBOX_STABLE_SYMBOLS)[number];

const TOKEN_DECIMALS: Readonly<Record<MarketsSandboxTokenSymbol, number>> = {
  SOL: 9,
  USDC: 6,
  USDG: 6,
  USDT: 6,
  PYUSD: 6,
};

const DEMO_FUNDING: Readonly<Record<MarketsSandboxTokenSymbol, string>> = {
  SOL: "1000",
  USDC: "100000",
  USDG: "100000",
  USDT: "100000",
  PYUSD: "100000",
};

export interface MarketsSandboxPosition {
  id: string;
  strategyId: string;
  provider: string;
  providerReference: string;
  strategyName: string;
  assetSymbol: string;
  assetMint: string;
  shareMint: string | null;
  amount: string;
  shares: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketsSandboxActivity {
  id: string;
  kind: "fund" | "deposit" | "withdrawal";
  createdAt: string;
  amount: string;
  symbol: string;
  strategyName?: string;
  swappedFrom?: string;
  swappedTo?: string;
}

export interface MarketsSandboxState {
  version: 1;
  balances: Record<MarketsSandboxTokenSymbol, string>;
  positions: MarketsSandboxPosition[];
  activity: MarketsSandboxActivity[];
  dvpTrades: DvpTrade[];
}

export interface MarketsSandboxDepositInput {
  strategyId: string;
  provider: string;
  providerReference: string;
  strategyName: string;
  assetSymbol: string;
  assetMint: string;
  shareMint?: string;
  payWith: MarketsSandboxStableSymbol;
  amount: string;
}

const EMPTY_BALANCES: Record<MarketsSandboxTokenSymbol, string> = {
  SOL: "0",
  USDC: "0",
  USDG: "0",
  USDT: "0",
  PYUSD: "0",
};

const EMPTY_STATE: MarketsSandboxState = {
  version: 1,
  balances: { ...EMPTY_BALANCES },
  positions: [],
  activity: [],
  dvpTrades: [],
};

const STORAGE_PREFIX = "sdp.markets.sandbox.v1";
const CHANGE_EVENT = "sdp:markets-sandbox-change";
const snapshotCache = new Map<string, { raw: string | null; state: MarketsSandboxState }>();
const memoryFallback = new Map<string, MarketsSandboxState>();
const storageDiverged = new Set<string>();

function isTokenSymbol(value: unknown): value is MarketsSandboxTokenSymbol {
  return MARKETS_SANDBOX_TOKEN_SYMBOLS.includes(value as MarketsSandboxTokenSymbol);
}

function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(value);
}

function isPosition(value: unknown): value is MarketsSandboxPosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MarketsSandboxPosition>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.strategyId === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.providerReference === "string" &&
    typeof candidate.strategyName === "string" &&
    typeof candidate.assetSymbol === "string" &&
    typeof candidate.assetMint === "string" &&
    (candidate.shareMint === null || typeof candidate.shareMint === "string") &&
    isCanonicalDecimal(candidate.amount) &&
    isCanonicalDecimal(candidate.shares) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function isActivity(value: unknown): value is MarketsSandboxActivity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MarketsSandboxActivity>;
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "fund" ||
      candidate.kind === "deposit" ||
      candidate.kind === "withdrawal") &&
    typeof candidate.createdAt === "string" &&
    isCanonicalDecimal(candidate.amount) &&
    typeof candidate.symbol === "string" &&
    (candidate.strategyName === undefined || typeof candidate.strategyName === "string") &&
    (candidate.swappedFrom === undefined || typeof candidate.swappedFrom === "string") &&
    (candidate.swappedTo === undefined || typeof candidate.swappedTo === "string")
  );
}

/** LocalStorage is untrusted input and may have been written by an older build. */
export function parseMarketsSandboxState(value: unknown): MarketsSandboxState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MarketsSandboxState>;
  if (candidate.version !== 1 || !candidate.balances || typeof candidate.balances !== "object") {
    return null;
  }
  const balances = candidate.balances as Partial<Record<MarketsSandboxTokenSymbol, unknown>>;
  if (MARKETS_SANDBOX_TOKEN_SYMBOLS.some((symbol) => !isCanonicalDecimal(balances[symbol]))) {
    return null;
  }
  if (!Array.isArray(candidate.positions) || !candidate.positions.every(isPosition)) return null;
  if (!Array.isArray(candidate.activity) || !candidate.activity.every(isActivity)) return null;
  const dvpTrades = Array.isArray(candidate.dvpTrades)
    ? candidate.dvpTrades.filter((trade): trade is DvpTrade =>
        Boolean(
          trade &&
            typeof trade === "object" &&
            typeof (trade as Partial<DvpTrade>).id === "string" &&
            typeof (trade as Partial<DvpTrade>).status === "string" &&
            (trade as Partial<DvpTrade>).legs
        )
      )
    : [];
  return {
    version: 1,
    balances: Object.fromEntries(
      MARKETS_SANDBOX_TOKEN_SYMBOLS.map((symbol) => [symbol, balances[symbol] as string])
    ) as Record<MarketsSandboxTokenSymbol, string>,
    positions: candidate.positions,
    activity: candidate.activity.slice(0, 100),
    dvpTrades,
  };
}

export function marketsSandboxStorageKey(projectId: string | null): string {
  return `${STORAGE_PREFIX}:${projectId ?? "default-sandbox"}`;
}

function decimalToAtoms(value: string, decimals: number): bigint | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) return null;
  const whole = match[1] ?? "0";
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0")
  );
}

function atomsToDecimal(atoms: bigint, decimals: number): string {
  if (atoms < 0n) throw new Error("Sandbox balances cannot be negative.");
  if (decimals === 0) return atoms.toString();
  const padded = atoms.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function normalizeMarketsSandboxAmount(
  value: string,
  symbol: MarketsSandboxTokenSymbol
): string | null {
  const atoms = decimalToAtoms(value, TOKEN_DECIMALS[symbol]);
  return atoms === null ? null : atomsToDecimal(atoms, TOKEN_DECIMALS[symbol]);
}

export function marketsSandboxAmountToAtoms(
  value: string,
  symbol: MarketsSandboxTokenSymbol
): string {
  const atoms = decimalToAtoms(value, TOKEN_DECIMALS[symbol]);
  if (atoms === null) throw new Error("Invalid sandbox amount.");
  return atoms.toString();
}

export function addMarketsSandboxAmounts(
  left: string,
  right: string,
  symbol: MarketsSandboxTokenSymbol
): string {
  const decimals = TOKEN_DECIMALS[symbol];
  const leftAtoms = decimalToAtoms(left, decimals);
  const rightAtoms = decimalToAtoms(right, decimals);
  if (leftAtoms === null || rightAtoms === null) throw new Error("Invalid sandbox amount.");
  return atomsToDecimal(leftAtoms + rightAtoms, decimals);
}

export function compareMarketsSandboxAmounts(
  left: string,
  right: string,
  symbol: MarketsSandboxTokenSymbol
): -1 | 0 | 1 {
  const decimals = TOKEN_DECIMALS[symbol];
  const leftAtoms = decimalToAtoms(left, decimals);
  const rightAtoms = decimalToAtoms(right, decimals);
  if (leftAtoms === null || rightAtoms === null) throw new Error("Invalid sandbox amount.");
  return leftAtoms === rightAtoms ? 0 : leftAtoms < rightAtoms ? -1 : 1;
}

function subtractMarketsSandboxAmounts(
  left: string,
  right: string,
  symbol: MarketsSandboxTokenSymbol
): string {
  const decimals = TOKEN_DECIMALS[symbol];
  const leftAtoms = decimalToAtoms(left, decimals);
  const rightAtoms = decimalToAtoms(right, decimals);
  if (leftAtoms === null || rightAtoms === null || leftAtoms < rightAtoms) {
    throw new Error("Insufficient sandbox balance.");
  }
  return atomsToDecimal(leftAtoms - rightAtoms, decimals);
}

type SandboxBalances = Record<MarketsSandboxTokenSymbol, string>;
type SandboxDvpAction = "fund" | "settle" | "cancel";

function sandboxDvpLegAmount(leg: DvpTrade["legs"][DvpTradeSide]): {
  symbol: MarketsSandboxTokenSymbol;
  amount: string;
} {
  if (!isTokenSymbol(leg.symbol)) {
    throw new Error("The sandbox wallet does not carry this asset.");
  }
  let atoms: bigint;
  try {
    atoms = BigInt(leg.amount);
  } catch {
    throw new Error("The sandbox trade amount is invalid.");
  }
  return {
    symbol: leg.symbol,
    amount: atomsToDecimal(atoms, TOKEN_DECIMALS[leg.symbol]),
  };
}

function fundSandboxDvpTrade(
  trade: DvpTrade,
  balances: SandboxBalances,
  side: DvpTradeSide | undefined,
  now: string
): DvpTrade {
  if (!side) throw new Error("Choose a trade leg to fund.");
  const leg = trade.legs[side];
  const debit = sandboxDvpLegAmount(leg);
  balances[debit.symbol] = subtractMarketsSandboxAmounts(
    balances[debit.symbol],
    debit.amount,
    debit.symbol
  );
  const fundedLeg = {
    ...leg,
    funding: {
      observedAmount: leg.amount,
      funded: true,
      surplus: null,
      frozen: false,
    },
    outcome: "funded" as const,
  };
  const otherSide = side === "a" ? "b" : "a";
  const otherLeg = trade.legs[otherSide];
  // The browser sandbox stands in for the remote counterparty too, so an
  // operator can click through the complete lifecycle without a second
  // account or any chain traffic.
  const simulatedCounterpartyLeg = otherLeg.party.wallet
    ? otherLeg
    : {
        ...otherLeg,
        funding: {
          observedAmount: otherLeg.amount,
          funded: true,
          surplus: null,
          frozen: false,
        },
        outcome: "funded" as const,
      };
  const legs = {
    ...trade.legs,
    [side]: fundedLeg,
    [otherSide]: simulatedCounterpartyLeg,
  };
  return {
    ...trade,
    legs,
    status:
      legs.a.funding?.funded === true && legs.b.funding?.funded === true
        ? "funded"
        : "partially_funded",
    observedAt: now,
    updatedAt: now,
  };
}

function settleSandboxDvpTrade(trade: DvpTrade, balances: SandboxBalances, now: string): DvpTrade {
  for (const ownerSide of ["a", "b"] as const) {
    if (!trade.legs[ownerSide].party.wallet) continue;
    const received = sandboxDvpLegAmount(trade.legs[ownerSide === "a" ? "b" : "a"]);
    balances[received.symbol] = addMarketsSandboxAmounts(
      balances[received.symbol],
      received.amount,
      received.symbol
    );
  }
  return {
    ...trade,
    status: "settled",
    legs: {
      a: { ...trade.legs.a, outcome: "delivered" },
      b: { ...trade.legs.b, outcome: "delivered" },
    },
    observedAt: now,
    updatedAt: now,
  };
}

function cancelSandboxDvpTrade(trade: DvpTrade, balances: SandboxBalances, now: string): DvpTrade {
  for (const leg of [trade.legs.a, trade.legs.b]) {
    if (!(leg.party.wallet && leg.funding?.funded)) continue;
    const refund = sandboxDvpLegAmount(leg);
    balances[refund.symbol] = addMarketsSandboxAmounts(
      balances[refund.symbol],
      refund.amount,
      refund.symbol
    );
  }
  return {
    ...trade,
    status: "cancelled",
    legs: {
      a: {
        ...trade.legs.a,
        outcome: trade.legs.a.funding?.funded ? "refunded" : "closed",
      },
      b: {
        ...trade.legs.b,
        outcome: trade.legs.b.funding?.funded ? "refunded" : "closed",
      },
    },
    observedAt: now,
    updatedAt: now,
  };
}

function applySandboxDvpAction(
  current: MarketsSandboxState,
  tradeId: string,
  action: SandboxDvpAction,
  side?: DvpTradeSide
): MarketsSandboxState {
  const trade = current.dvpTrades.find((candidate) => candidate.id === tradeId);
  if (!trade) throw new Error("That sandbox trade no longer exists.");
  const now = new Date().toISOString();
  const balances = { ...current.balances };
  const updated =
    action === "fund"
      ? fundSandboxDvpTrade(trade, balances, side, now)
      : action === "settle"
        ? settleSandboxDvpTrade(trade, balances, now)
        : cancelSandboxDvpTrade(trade, balances, now);
  return {
    ...current,
    balances,
    dvpTrades: current.dvpTrades.map((candidate) =>
      candidate.id === tradeId ? updated : candidate
    ),
  };
}

function readState(key: string): MarketsSandboxState {
  if (typeof window === "undefined") return EMPTY_STATE;
  if (storageDiverged.has(key)) return memoryFallback.get(key) ?? EMPTY_STATE;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? EMPTY_STATE;
  }
  const cached = snapshotCache.get(key);
  if (cached?.raw === raw) return cached.state;
  let parsed: MarketsSandboxState | null = null;
  if (raw) {
    try {
      parsed = parseMarketsSandboxState(JSON.parse(raw));
    } catch {
      parsed = null;
    }
  }
  const state = parsed ?? EMPTY_STATE;
  snapshotCache.set(key, { raw, state });
  memoryFallback.set(key, state);
  return state;
}

function writeState(key: string, state: MarketsSandboxState): void {
  const raw = JSON.stringify(state);
  memoryFallback.set(key, state);
  snapshotCache.set(key, { raw, state });
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, raw);
      storageDiverged.delete(key);
    } catch {
      storageDiverged.add(key);
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key } }));
  }
}

function updateState(key: string, update: (current: MarketsSandboxState) => MarketsSandboxState) {
  writeState(key, update(readState(key)));
}

function id(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}_${random}`;
}

function subscribe(key: string, listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onChange = (event: Event) => {
    if (event instanceof StorageEvent) {
      if (event.key === key) {
        snapshotCache.delete(key);
        listener();
      }
      return;
    }
    if ((event as CustomEvent<{ key?: string }>).detail?.key === key) listener();
  };
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function useMarketsSandbox(projectId: string | null) {
  const key = marketsSandboxStorageKey(projectId);
  const state = useSyncExternalStore(
    useCallback((listener) => subscribe(key, listener), [key]),
    useCallback(() => readState(key), [key]),
    () => EMPTY_STATE
  );

  const fund = useCallback(() => {
    const now = new Date().toISOString();
    updateState(key, (current) => ({
      ...current,
      balances: Object.fromEntries(
        MARKETS_SANDBOX_TOKEN_SYMBOLS.map((symbol) => [
          symbol,
          addMarketsSandboxAmounts(current.balances[symbol], DEMO_FUNDING[symbol], symbol),
        ])
      ) as Record<MarketsSandboxTokenSymbol, string>,
      activity: [
        ...MARKETS_SANDBOX_TOKEN_SYMBOLS.map((symbol) => ({
          id: id("sandbox_fund"),
          kind: "fund" as const,
          createdAt: now,
          amount: DEMO_FUNDING[symbol],
          symbol,
        })),
        ...current.activity,
      ].slice(0, 100),
    }));
  }, [key]);

  const deposit = useCallback(
    (input: MarketsSandboxDepositInput) => {
      const amount = normalizeMarketsSandboxAmount(input.amount, input.payWith);
      if (!amount || compareMarketsSandboxAmounts(amount, "0", input.payWith) !== 1) {
        throw new Error("Enter a valid deposit amount.");
      }
      updateState(key, (current) => {
        if (
          compareMarketsSandboxAmounts(current.balances[input.payWith], amount, input.payWith) < 0
        ) {
          throw new Error(`Not enough ${input.payWith} in the sandbox wallet.`);
        }
        const now = new Date().toISOString();
        const existing = current.positions.find(
          (position) => position.strategyId === input.strategyId
        );
        const position: MarketsSandboxPosition = existing
          ? {
              ...existing,
              amount: addMarketsSandboxAmounts(existing.amount, amount, input.payWith),
              shares: addMarketsSandboxAmounts(existing.shares, amount, input.payWith),
              updatedAt: now,
            }
          : {
              id: id("sandbox_position"),
              strategyId: input.strategyId,
              provider: input.provider,
              providerReference: input.providerReference,
              strategyName: input.strategyName,
              assetSymbol: input.assetSymbol,
              assetMint: input.assetMint,
              shareMint: input.shareMint ?? null,
              amount,
              shares: amount,
              createdAt: now,
              updatedAt: now,
            };
        return {
          ...current,
          balances: {
            ...current.balances,
            [input.payWith]: subtractMarketsSandboxAmounts(
              current.balances[input.payWith],
              amount,
              input.payWith
            ),
          },
          positions: existing
            ? current.positions.map((candidate) =>
                candidate.strategyId === input.strategyId ? position : candidate
              )
            : [position, ...current.positions],
          activity: [
            {
              id: id("sandbox_deposit"),
              kind: "deposit" as const,
              createdAt: now,
              amount,
              symbol: input.assetSymbol,
              strategyName: input.strategyName,
              ...(input.payWith === input.assetSymbol
                ? {}
                : { swappedFrom: input.payWith, swappedTo: input.assetSymbol }),
            },
            ...current.activity,
          ].slice(0, 100),
        };
      });
    },
    [key]
  );

  const withdraw = useCallback(
    (positionId: string, amountInput: string, receiveAs: MarketsSandboxStableSymbol) => {
      updateState(key, (current) => {
        const position = current.positions.find((candidate) => candidate.id === positionId);
        if (!position) throw new Error("That sandbox position no longer exists.");
        const amount = normalizeMarketsSandboxAmount(amountInput, receiveAs);
        if (!amount || compareMarketsSandboxAmounts(amount, "0", receiveAs) !== 1) {
          throw new Error("Enter a valid withdrawal amount.");
        }
        if (compareMarketsSandboxAmounts(position.amount, amount, receiveAs) < 0) {
          throw new Error("That exceeds the sandbox position balance.");
        }
        const now = new Date().toISOString();
        const remaining = subtractMarketsSandboxAmounts(position.amount, amount, receiveAs);
        return {
          ...current,
          balances: {
            ...current.balances,
            [receiveAs]: addMarketsSandboxAmounts(current.balances[receiveAs], amount, receiveAs),
          },
          positions:
            remaining === "0"
              ? current.positions.filter((candidate) => candidate.id !== positionId)
              : current.positions.map((candidate) =>
                  candidate.id === positionId
                    ? { ...candidate, amount: remaining, shares: remaining, updatedAt: now }
                    : candidate
                ),
          activity: [
            {
              id: id("sandbox_withdrawal"),
              kind: "withdrawal" as const,
              createdAt: now,
              amount,
              symbol: receiveAs,
              strategyName: position.strategyName,
              ...(receiveAs === position.assetSymbol
                ? {}
                : { swappedFrom: position.assetSymbol, swappedTo: receiveAs }),
            },
            ...current.activity,
          ].slice(0, 100),
        };
      });
    },
    [key]
  );

  const reset = useCallback(
    () =>
      writeState(key, {
        ...EMPTY_STATE,
        balances: { ...EMPTY_BALANCES },
        positions: [],
        activity: [],
        dvpTrades: [],
      }),
    [key]
  );

  const saveDvpTrade = useCallback(
    (trade: DvpTrade) => {
      updateState(key, (current) => ({
        ...current,
        dvpTrades: [trade, ...current.dvpTrades.filter((candidate) => candidate.id !== trade.id)],
      }));
    },
    [key]
  );

  const updateDvpTrade = useCallback(
    (tradeId: string, update: (trade: DvpTrade) => DvpTrade) => {
      updateState(key, (current) => ({
        ...current,
        dvpTrades: current.dvpTrades.map((trade) => (trade.id === tradeId ? update(trade) : trade)),
      }));
    },
    [key]
  );

  const actOnDvpTrade = useCallback(
    (tradeId: string, action: SandboxDvpAction, side?: DvpTradeSide) => {
      updateState(key, (current) => applySandboxDvpAction(current, tradeId, action, side));
    },
    [key]
  );

  return {
    state,
    fund,
    deposit,
    withdraw,
    reset,
    saveDvpTrade,
    updateDvpTrade,
    actOnDvpTrade,
  };
}
