"use client";

import type { EarnVaultPosition, EarnVaultWithdrawal, SdpEnvironment } from "@sdp/types";
import type {
  EarnVaultAsyncWithdrawalEvent,
  EarnVaultAsyncWithdrawalRoute,
} from "./earn-vault-async-withdrawal";
import type { VaultSubmissionObserver } from "./earn-vault-movement";
import {
  EarnVaultParRedemptionModal,
  type EarnVaultParRedemptionSource,
} from "./earn-vault-par-redemption-modal";
import { EarnVaultQueuedWithdrawModal } from "./earn-vault-queued-withdraw-modal";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";

interface EarnVaultAsyncWithdrawModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onSubmissionStart?: VaultSubmissionObserver;
  onRequested?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onSettled?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onMovementUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  onWithdrawn?: (
    withdrawal: EarnVaultWithdrawal,
    intent: { amount: string; submittedAt: number }
  ) => void;
  /** A par route may redeem the position's held intermediate instead of shares. */
  parSource?: EarnVaultParRedemptionSource;
  position: EarnVaultPosition;
  projectId: string;
  route: EarnVaultAsyncWithdrawalRoute;
}

/**
 * Provider-neutral renderer for a long-lived withdrawal. Mechanism-specific
 * fields stay inside their own flow; the caller never dispatches on provider.
 */
export function EarnVaultAsyncWithdrawModal({
  onRequested,
  onSettled,
  onMovementUpdated,
  onWithdrawn,
  parSource,
  route,
  ...props
}: EarnVaultAsyncWithdrawModalProps) {
  switch (route.kind) {
    case "queue":
      return (
        <EarnVaultQueuedWithdrawModal
          {...props}
          onRequested={(request) => onRequested?.({ kind: "queue", request })}
          onSettled={(request) => onSettled?.({ kind: "queue", request })}
          terms={route.terms}
        />
      );
    case "provider_order":
      return (
        <EarnVaultWithdrawModal
          {...props}
          onMovementUpdated={onMovementUpdated}
          onWithdrawn={onWithdrawn}
          settlement="provider_order"
        />
      );
    case "operator_redemption":
      return (
        <EarnVaultParRedemptionModal
          {...props}
          onRequested={(request) => onRequested?.({ kind: "operator_redemption", request })}
          onSettled={(request) => onSettled?.({ kind: "operator_redemption", request })}
          source={parSource}
          terms={route.terms}
        />
      );
  }
}
