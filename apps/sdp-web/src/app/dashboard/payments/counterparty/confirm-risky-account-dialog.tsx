"use client";

import { Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { ComplianceProviderResult } from "@/lib/compliance";
import { formatRiskScore, toProviderLabel } from "../payments-workspace.data";

interface ConfirmRiskyAccountDialogProps {
  isOpen: boolean;
  providers: ComplianceProviderResult[];
  /** False when screening could not be completed (e.g. provider unavailable). */
  screened?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmRiskyAccountDialog({
  isOpen,
  providers,
  screened = true,
  onConfirm,
  onClose,
}: ConfirmRiskyAccountDialogProps) {
  const [confirming, setConfirming] = useState(false);

  async function handleConfirm() {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      ariaLabel="Confirm risky wallet"
      onClose={confirming ? undefined : onClose}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-status-error-text">
            <ShieldAlertIcon className="size-5" />
          </span>
          <div className="space-y-1">
            <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
              {screened ? "This wallet was flagged" : "Couldn't screen this wallet"}
            </h2>
            <p className="text-sm text-text-medium">
              {screened
                ? `The following risk ${providers.length === 1 ? "analysis" : "analyses"} flagged this wallet as high risk. Confirm you're okay adding it anyway.`
                : "We couldn't run a risk screening on this address (compliance screening isn't available). Confirm you're okay adding it without a screen."}
            </p>
          </div>
        </div>

        {providers.length > 0 && (
          <ul className="space-y-2">
            {providers.map((result) => (
              <li
                key={result.provider}
                className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-status-error-text"
              >
                <span className="font-medium">{toProviderLabel(result.provider)}</span>
                <span className="text-xs">{formatRiskScore(result)}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={confirming}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={confirming}
            iconLeft={confirming ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {confirming ? "Adding" : "Add anyway"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
