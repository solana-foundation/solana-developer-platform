"use client";

import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "./earn-idempotency-key-store";

/**
 * The vault DEPOSIT idempotency key store (PRO-1692).
 *
 * All of the machinery — the per-tab `sessionStorage` tier, the in-memory
 * fallback, the quota-divergence handling, the approval-hold pinning, the
 * expiring-entry bound — lives in `earn-idempotency-key-store.ts`, shared with
 * the withdrawal flow. This module owns the two things that make a DEPOSIT a
 * deposit: its versioned storage key (which existing tabs already hold data
 * under — never change it casually) and what makes two submissions the SAME
 * request.
 */
export const vaultDepositIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:vault-deposit:idempotency:v1"
);

/**
 * Test-only: clear the shared module-scope tiers so specs are
 * order-independent. Production never calls this.
 *
 * @internal
 */
export function resetVaultDepositTrackingStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
}

/**
 * What makes two submissions the SAME request: the PROJECT, the strategy, the
 * wallet paying for it, and the amount. Change any one and it is a different
 * deposit, not a retry — which is exactly the distinction an idempotency key
 * has to encode.
 *
 * The project is in here for a reason that only shows up once the key is
 * durable. A custody config may be ORGANIZATION-level, so two projects can
 * resolve the same `custody_wallets` row; without the project, switching
 * project in one tab and re-submitting the same strategy and amount reuses the
 * first project's key. The API's replay lookup is keyed on
 * `(organization_id, request_id)`, so that reused key resolves the FIRST
 * project's movement — returning it as a replay instead of making the deposit.
 * A ref-scoped key never survived a project switch, so this only became
 * reachable when the key started outliving the component.
 */
export function vaultDepositRequestFingerprint(input: {
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  strategyId: string;
  custodyWalletId: string;
  amount: string;
}): string {
  return JSON.stringify([input.projectId, input.strategyId, input.custodyWalletId, input.amount]);
}

export function claimVaultDepositIdempotencyKey(fingerprint: string): string {
  return vaultDepositIdempotencyKeyStore.claim(fingerprint);
}

export function holdVaultDepositIdempotencyKey(fingerprint: string): void {
  vaultDepositIdempotencyKeyStore.hold(fingerprint);
}

export function isVaultDepositIdempotencyKeyHeld(fingerprint: string): boolean {
  return vaultDepositIdempotencyKeyStore.isHeld(fingerprint);
}

export function releaseVaultDepositIdempotencyKey(fingerprint: string): void {
  vaultDepositIdempotencyKeyStore.release(fingerprint);
}
