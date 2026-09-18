"use client";

import type { EarnVaultPosition, EarnVaultWithdrawal, SdpEnvironment } from "@sdp/types";
import type {
  EarnVaultAsyncWithdrawalEvent,
  EarnVaultAsyncWithdrawalRoute,
} from "./earn-vault-async-withdrawal";
import { EarnVaultQueuedWithdrawModal } from "./earn-vault-queued-withdraw-modal";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";

interface EarnVaultAsyncWithdrawModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onRequested?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onSettled?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onMovementUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  onWithdrawn?: (
    withdrawal: EarnVaultWithdrawal,
    intent: { amount: string; projectBalance: boolean }
  ) => void;
  position: EarnVaultPosition;
  projectId: string | null;
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
  }
}
