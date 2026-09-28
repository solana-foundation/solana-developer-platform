"use client";

import type { EarnVaultDepositRecord, EarnVaultWithdrawal } from "@sdp/types";
import {
  useEarnVaultDepositOutcome,
  useEarnVaultWithdrawalOutcome,
  useEarnWithdrawalOutcomeToast,
} from "./earn-program-data";

/** Lightweight polling mounts kept separate from the large transaction modals. */
export function EarnVaultDepositOutcomeTracker({
  movementId,
  onSettled,
  onUpdated,
}: {
  movementId: string;
  onUpdated?: (deposit: EarnVaultDepositRecord) => void;
  onSettled?: (deposit: EarnVaultDepositRecord) => void;
}) {
  useEarnVaultDepositOutcome(movementId, onSettled, onUpdated);
  return null;
}

export function EarnVaultWithdrawalOutcomeTracker({
  movementId,
  onSettled,
  onUpdated,
}: {
  movementId: string;
  onUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  onSettled?: (withdrawal: EarnVaultWithdrawal) => void;
}) {
  useEarnVaultWithdrawalOutcome(movementId, onSettled, onUpdated);
  return null;
}

export function EarnWithdrawalOutcomeTracker({
  programId,
  withdrawalRef,
  onSettled,
}: {
  programId: string;
  withdrawalRef: string;
  onSettled?: () => void;
}) {
  useEarnWithdrawalOutcomeToast(programId, withdrawalRef, onSettled);
  return null;
}
