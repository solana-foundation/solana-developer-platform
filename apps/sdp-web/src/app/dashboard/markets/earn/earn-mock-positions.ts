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
  redemptionDelayDays: number | null
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

  if (redemptionDelayDays !== null && redemptionDelayDays > 0) {
    const requestedAt = new Date();
    const availableAt = new Date(requestedAt.getTime() + redemptionDelayDays * 24 * 60 * 60 * 1000);
    const redemption: MockEarnRedemption = {
      id: `earn_redemption_mock_${crypto.randomUUID()}`,
      positionId: position.id,
      strategyId: position.strategyId,
      walletId: position.walletId,
      tokenMint: position.tokenMint,
      amount: withdrawn,
      requestedAt: requestedAt.toISOString(),
      availableAt: availableAt.toISOString(),
    };
    write(REDEMPTIONS_KEY, [redemption, ...readRedemptions()]);
  }

  write(POSITIONS_KEY, nextPositions);
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
