"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type {
  ActionConfirmationState,
  ActionExecutionInput,
  ActionExecutionResult,
  RunActionOptions,
} from "./token-management-workspace.types";
import { executeActionRequest } from "./token-management-workspace.utils";

export function useTokenActionRunner() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastActionResult, setLastActionResult] = useState<ActionExecutionResult | null>(null);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmationState | null>(
    null
  );

  const executeAction = (input: ActionExecutionInput, options: RunActionOptions = {}) => {
    const submitToast = options.submitToast ?? `Submitting ${input.label.toLowerCase()}...`;
    const successToast = options.successToast ?? "Transaction finalized successfully.";
    const toastId = toast.loading(submitToast);

    startTransition(async () => {
      const result = await executeActionRequest(input);
      setLastActionResult(result);

      if (result.ok) {
        setActionConfirmation(null);
        toast.success(successToast, { id: toastId });
        router.refresh();
        return;
      }

      toast.error(result.message, { id: toastId });
    });
  };

  const runAction = (input: ActionExecutionInput, options: RunActionOptions = {}) => {
    if (options.requiresConfirmation) {
      setActionConfirmation({
        input,
        options: {
          confirmationTitle: options.confirmationTitle ?? "Send transaction?",
          confirmationDescription:
            options.confirmationDescription ??
            "This will submit an on-chain transaction. Do you want to continue?",
          confirmButtonLabel: options.confirmButtonLabel ?? "Go ahead",
          submitToast: options.submitToast ?? `Submitting ${input.label.toLowerCase()}...`,
          successToast: options.successToast ?? "Transaction finalized successfully.",
        },
      });
      return;
    }

    executeAction(input, options);
  };

  const dismissActionConfirmation = () => {
    setActionConfirmation(null);
  };

  const confirmAction = () => {
    const pendingConfirmation = actionConfirmation;
    if (!pendingConfirmation) {
      return;
    }
    setActionConfirmation(null);
    executeAction(pendingConfirmation.input, pendingConfirmation.options);
  };

  return {
    isPending,
    lastActionResult,
    actionConfirmation,
    runAction,
    dismissActionConfirmation,
    confirmAction,
  };
}
