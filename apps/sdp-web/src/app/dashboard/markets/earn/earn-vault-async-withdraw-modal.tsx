"use client";

import type { EarnVaultPosition, SdpEnvironment } from "@sdp/types";
import type {
  EarnVaultAsyncWithdrawalEvent,
  EarnVaultAsyncWithdrawalRoute,
} from "./earn-vault-async-withdrawal";
import { EarnVaultQueuedWithdrawModal } from "./earn-vault-queued-withdraw-modal";

interface EarnVaultAsyncWithdrawModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onRequested?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onSettled?: (event: EarnVaultAsyncWithdrawalEvent) => void;
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
  }
}
