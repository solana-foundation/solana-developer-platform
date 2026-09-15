import type { EarnVaultDirectMovementStatus, EarnVaultMovementStatus } from "@sdp/types";

export type EarnVaultPositionUiStatus = "pending" | "active";

export interface EarnVaultUiState {
  positionStatus: EarnVaultPositionUiStatus;
  progressStep: number;
}

export interface EarnVaultPositionStatusDisplay {
  label: string;
  variant: "success" | "warning";
}

const DEPOSIT_UI_STATE: Readonly<Record<EarnVaultMovementStatus, EarnVaultUiState>> = {
  pending: { positionStatus: "pending", progressStep: 2 },
  submitted: { positionStatus: "pending", progressStep: 2 },
  confirmed: { positionStatus: "active", progressStep: 3 },
  failed: { positionStatus: "active", progressStep: 2 },
};

const WITHDRAWAL_UI_STATE: Readonly<Record<EarnVaultDirectMovementStatus, EarnVaultUiState>> = {
  requested: { positionStatus: "pending", progressStep: 2 },
  submitted: { positionStatus: "pending", progressStep: 2 },
  confirmed: { positionStatus: "pending", progressStep: 2 },
  finalized: { positionStatus: "active", progressStep: 3 },
  failed: { positionStatus: "active", progressStep: 2 },
};

export function earnVaultDepositUiState(status: EarnVaultMovementStatus): EarnVaultUiState {
  return DEPOSIT_UI_STATE[status];
}

export function earnVaultWithdrawalUiState(
  status: EarnVaultDirectMovementStatus
): EarnVaultUiState {
  return WITHDRAWAL_UI_STATE[status];
}

export function earnVaultPositionStatusDisplay(
  status: EarnVaultPositionUiStatus,
  pendingLabel: string,
  activeLabel: string
): EarnVaultPositionStatusDisplay {
  if (status === "pending") {
    return { label: pendingLabel, variant: "warning" };
  }

  return { label: activeLabel, variant: "success" };
}
