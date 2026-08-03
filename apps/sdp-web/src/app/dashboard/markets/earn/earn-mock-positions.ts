"use client";

import { useSyncExternalStore } from "react";

/**
 * Client-side mock position + redemption store for the Earn design scaffold.
 * State created by the deposit wizard and withdraw modal persists in
 * localStorage so the flow feels end-to-end across navigations. Replaced by
 * /v1/earn/positions and /v1/earn/movements once the execution path lands —
 * nothing outside this file knows about the storage.
 *
 * Withdrawal semantics mirror the product's liquidity terms: instant
 * strategies settle immediately (position shrinks, no residue), delayed
 * strategies shrink the position now and park the funds in a pending
 * redemption until `availableAt` passes.
 */

export interface MockEarnPosition {
  id: string;
  strategyId: string;
  walletId: string;
  tokenMint: string;
  /** Display units (not base units) — mock only. */
  amount: number;
  createdAt: string;
}

export interface MockEarnRedemption {
  id: string;
  positionId: string;
  strategyId: string;
  walletId: string;
  tokenMint: string;
  /** Display units (not base units) — mock only. */
  amount: number;
  requestedAt: string;
  /** ISO timestamp when the funds settle; pending until then. */
  availableAt: string;
}

export interface MockEarnWithdrawalRoute {
  positionId: string;
  redemptionDelayDays: number | null;
  /** Portion that settles immediately even when the remaining leg is delayed. */
  intradayFraction?: number;
}

export interface MockEarnWithdrawalLeg {
  positionId: string;
  amount: number;
}

const POSITIONS_KEY = "sdp-earn-mock-positions";
const REDEMPTIONS_KEY = "sdp-earn-mock-redemptions";
const CHANGE_EVENT = "sdp:earn-mock-positions-change";

const EMPTY_POSITIONS: readonly MockEarnPosition[] = [];
const EMPTY_REDEMPTIONS: readonly MockEarnRedemption[] = [];

function createCache<T>(fallback: readonly T[]) {
  let raw: string | null = null;
  let parsed: readonly T[] = fallback;
  return (storageKey: string): readonly T[] => {
    if (typeof window === "undefined") return fallback;
    const next = window.localStorage.getItem(storageKey);
    if (next === raw) return parsed;
    try {
      const value = next ? JSON.parse(next) : [];
      parsed = Array.isArray(value) ? (value as T[]) : fallback;
    } catch {
      parsed = fallback;
    }
    raw = next;
    return parsed;
  };
}

const readPositionsCached = createCache<MockEarnPosition>(EMPTY_POSITIONS);
const readRedemptionsCached = createCache<MockEarnRedemption>(EMPTY_REDEMPTIONS);

function readPositions(): readonly MockEarnPosition[] {
  return readPositionsCached(POSITIONS_KEY);
}

function readRedemptions(): readonly MockEarnRedemption[] {
  return readRedemptionsCached(REDEMPTIONS_KEY);
}

function write(storageKey: string, value: readonly unknown[]): void {
  window.localStorage.setItem(storageKey, JSON.stringify(value));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function delayedWithdrawalAmount(amount: number, intradayFraction = 0): number {
  const immediateFraction = Math.min(1, Math.max(0, intradayFraction));
  return amount * (1 - immediateFraction);
}

export function addMockPosition(position: Omit<MockEarnPosition, "id" | "createdAt">): void {
  const next: MockEarnPosition = {
    ...position,
    id: `earn_position_mock_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  write(POSITIONS_KEY, [next, ...readPositions()]);
}

/**
 * Withdraw `amount` from a position. Pass `redemptionDelayDays` for
 * delayed-liquidity strategies to park the amount as a pending redemption;
 * instant strategies settle immediately.
 */
export function withdrawFromMockPosition(
  positionId: string,
  amount: number,
  redemptionDelayDays: number | null,
  intradayFraction = 0
): void {
  const positions = readPositions();
  const position = positions.find((candidate) => candidate.id === positionId);
  if (!position || amount <= 0) return;

  const withdrawn = Math.min(amount, position.amount);
  const remaining = position.amount - withdrawn;
  const nextPositions =
    remaining > 0
      ? positions.map((candidate) =>
          candidate.id === positionId ? { ...candidate, amount: remaining } : candidate
        )
      : positions.filter((candidate) => candidate.id !== positionId);

  const pendingAmount = delayedWithdrawalAmount(withdrawn, intradayFraction);

  if (redemptionDelayDays !== null && redemptionDelayDays > 0 && pendingAmount > 0) {
    const requestedAt = new Date();
    const availableAt = new Date(requestedAt.getTime() + redemptionDelayDays * 24 * 60 * 60 * 1000);
    const redemption: MockEarnRedemption = {
      id: `earn_redemption_mock_${crypto.randomUUID()}`,
      positionId: position.id,
      strategyId: position.strategyId,
      walletId: position.walletId,
      tokenMint: position.tokenMint,
      amount: pendingAmount,
      requestedAt: requestedAt.toISOString(),
      availableAt: availableAt.toISOString(),
    };
    write(REDEMPTIONS_KEY, [redemption, ...readRedemptions()]);
  }

  write(POSITIONS_KEY, nextPositions);
}

/**
 * Plan an exact-total proportional withdrawal in caller order. An empty plan
 * means the request is invalid or exceeds the currently available balance.
 */
export function planProportionalWithdrawal(
  positions: readonly { positionId: string; amount: number }[],
  requestedAmount: number
): MockEarnWithdrawalLeg[] {
  const available = positions.reduce((total, position) => total + position.amount, 0);
  if (
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0 ||
    available <= 0 ||
    requestedAmount > available
  ) {
    return [];
  }

  let routed = 0;
  return positions.map((position, index) => {
    const amount =
      index === positions.length - 1
        ? Math.max(0, requestedAmount - routed)
        : requestedAmount * (position.amount / available);
    routed += amount;
    return { positionId: position.positionId, amount };
  });
}

/**
 * Atomically re-resolve and proportionally reduce the requested positions.
 * Returns zero without mutation if another tab made the request unaffordable.
 */
export function withdrawFromMockPositionsProportionally(
  routes: readonly MockEarnWithdrawalRoute[],
  requestedAmount: number
): number {
  const routeByPosition = new Map(routes.map((route) => [route.positionId, route]));
  const positions = readPositions();
  const eligiblePositions = positions.filter((position) => routeByPosition.has(position.id));
  const withdrawalLegs = planProportionalWithdrawal(
    eligiblePositions.map((position) => ({ positionId: position.id, amount: position.amount })),
    requestedAmount
  );
  if (withdrawalLegs.length === 0) return 0;

  const amountByPosition = new Map(
    withdrawalLegs.map((leg) => [leg.positionId, leg.amount] as const)
  );
  const requestedAt = new Date();
  const newRedemptions: MockEarnRedemption[] = [];

  for (const position of eligiblePositions) {
    const withdrawn = amountByPosition.get(position.id) ?? 0;
    const route = routeByPosition.get(position.id);
    if (!route || withdrawn <= 0) continue;

    const pendingAmount = delayedWithdrawalAmount(withdrawn, route.intradayFraction);
    if (route.redemptionDelayDays !== null && route.redemptionDelayDays > 0 && pendingAmount > 0) {
      const availableAt = new Date(
        requestedAt.getTime() + route.redemptionDelayDays * 24 * 60 * 60 * 1000
      );
      newRedemptions.push({
        id: `earn_redemption_mock_${crypto.randomUUID()}`,
        positionId: position.id,
        strategyId: position.strategyId,
        walletId: position.walletId,
        tokenMint: position.tokenMint,
        amount: pendingAmount,
        requestedAt: requestedAt.toISOString(),
        availableAt: availableAt.toISOString(),
      });
    }
  }

  const nextPositions = positions.flatMap((position) => {
    const withdrawn = amountByPosition.get(position.id);
    if (withdrawn === undefined) return [position];
    const remaining = position.amount - withdrawn;
    return remaining > 0 ? [{ ...position, amount: remaining }] : [];
  });

  if (newRedemptions.length > 0) {
    write(REDEMPTIONS_KEY, [...newRedemptions, ...readRedemptions()]);
  }
  write(POSITIONS_KEY, nextPositions);
  return requestedAmount;
}

export function clearMockRedemption(redemptionId: string): void {
  write(
    REDEMPTIONS_KEY,
    readRedemptions().filter((redemption) => redemption.id !== redemptionId)
  );
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useMockEarnPositions(): readonly MockEarnPosition[] {
  return useSyncExternalStore(subscribe, readPositions, () => EMPTY_POSITIONS);
}

export function useMockEarnRedemptions(): readonly MockEarnRedemption[] {
  return useSyncExternalStore(subscribe, readRedemptions, () => EMPTY_REDEMPTIONS);
}
