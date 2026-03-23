"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
  const [isPending, setIsPending] = useState(false);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmationState | null>(
    null
  );

  const executeAction = async (
    input: ActionExecutionInput,
    options: RunActionOptions = {}
  ): Promise<ActionExecutionResult> => {
    const submitToast = options.submitToast ?? `Submitting ${input.label.toLowerCase()}...`;
    const successToast = options.successToast ?? "Transaction finalized successfully.";
    const toastId = toast.loading(submitToast);

    setIsPending(true);
    try {
      const result = await executeActionRequest(input);

      if (result.ok) {
        setActionConfirmation(null);
        await options.onSuccess?.(result);
        router.refresh();
        toast.success(successToast, { id: toastId });
        return result;
      }

      toast.error(result.message, { id: toastId });
      return result;
    } finally {
      setIsPending(false);
    }
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
          onSuccess: options.onSuccess,
        },
      });
      return;
    }

    void executeAction(input, options);
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
    void executeAction(pendingConfirmation.input, pendingConfirmation.options);
  };

  return {
    isPending,
    actionConfirmation,
    runAction,
    runActionImmediately: executeAction,
    dismissActionConfirmation,
    confirmAction,
  };
}
