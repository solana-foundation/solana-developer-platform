import type {
  EarnVaultDirectMovementStatus,
  EarnVaultMovementStatus,
  EarnVaultWithdrawal,
} from "@sdp/types/earn";
import type { BadgeVariant } from "@sdp/ui/badge";
import type { useTranslations } from "@/i18n/provider";
import { compareUnsignedDecimals } from "./earn-decimal";

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
  confirmed: { positionStatus: "active", progressStep: 3 },
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

/**
 * The status badge for a vault position, in the module's own pending/active
 * copy. Every surface that badges a position reads the same two labels, so
 * the pair is named here once instead of once per call site.
 */
export function earnVaultPositionStatusLabels(
  status: EarnVaultPositionUiStatus,
  t: ReturnType<typeof useTranslations>
): EarnVaultPositionStatusDisplay {
  return earnVaultPositionStatusDisplay(
    status,
    t("DashboardMarkets.treasury.positionStatusPending"),
    t("DashboardMarkets.treasury.positionStatusActive")
  );
}

/**
 * The position badge a direct withdrawal's receipt carries. A settled exit that
 * redeemed every share the position held at its last read closed the position,
 * so the badge reads Closed instead of the shared Active.
 *
 * @param withdrawal - The withdrawal the receipt describes.
 * @param positionShares - The position's share balance at its last read, when known.
 * @param t - The translator.
 * @returns The badge, or undefined when that read could not count the shares,
 *   so the receipt keeps the withdrawal's own status instead of claiming what remains.
 */
export function earnVaultWithdrawalPositionStatusLabels(
  withdrawal: Pick<EarnVaultWithdrawal, "shares" | "status">,
  positionShares: string | undefined,
  t: ReturnType<typeof useTranslations>
): EarnVaultPositionStatusDisplay | undefined {
  const { positionStatus } = earnVaultWithdrawalUiState(withdrawal.status);
  const settled = withdrawal.status === "confirmed" || withdrawal.status === "finalized";
  if (!settled) return earnVaultPositionStatusLabels(positionStatus, t);
  if (positionShares === undefined) return undefined;
  const ordering = compareUnsignedDecimals(withdrawal.shares, positionShares);
  if (ordering === undefined) return undefined;
  if (ordering < 0) return earnVaultPositionStatusLabels(positionStatus, t);
  return { label: t("DashboardMarkets.treasury.positionStatusClosed"), variant: "success" };
}

/**
 * The status badge's variant as an outcome mark's tone. Both vault modals close
 * on the same three marks, so one mapping — a fourth spelling of it is how two
 * receipts end up disagreeing about what "info" looks like.
 */
export function vaultOutcomeTone(statusVariant: BadgeVariant): "info" | "success" | "warning" {
  if (statusVariant === "success") return "success";
  if (statusVariant === "warning") return "warning";
  return "info";
}
