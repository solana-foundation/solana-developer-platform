"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import type {
  ActionConfirmationState,
  ActionExecutionInput,
  ActionExecutionResult,
  RunActionOptions,
} from "./token-management-workspace.types";
import { executeActionRequest } from "./token-management-workspace.utils";

export function useTokenActionRunner() {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmationState | null>(
    null
  );

  const executeAction = async (
    input: ActionExecutionInput,
    options: RunActionOptions = {}
  ): Promise<ActionExecutionResult> => {
    const submitToast =
      options.submitToast ??
      t("DashboardIssuance.management.submittingAction", { action: input.label.toLowerCase() });
    const successToast =
      options.successToast ?? t("DashboardIssuance.management.transactionFinalized");
    const toastId = toast.loading(submitToast, {
      position: "bottom-right",
    });

    setIsPending(true);
    try {
      const result = await executeActionRequest(input, t);

      if (result.ok) {
        setActionConfirmation(null);
        toast.success(successToast, { id: toastId, position: "bottom-right" });
        try {
          await options.onSuccess?.(result);
          router.refresh();
        } catch (refreshError) {
          console.error("Token action post-success refresh failed", refreshError);
        }
        return result;
      }

      toast.error(result.message, { id: toastId, position: "bottom-right" });
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("DashboardIssuance.management.transactionFailed");
      toast.error(message, { id: toastId, position: "bottom-right" });
      return {
        ok: false,
        message,
        status: null,
        body: null,
      };
    } finally {
      setIsPending(false);
    }
  };

  const runAction = (input: ActionExecutionInput, options: RunActionOptions = {}) => {
    if (options.requiresConfirmation) {
      setActionConfirmation({
        input,
        options: {
          confirmationTitle:
            options.confirmationTitle ?? t("DashboardIssuance.management.sendTransaction"),
          confirmationDescription:
            options.confirmationDescription ??
            t("DashboardIssuance.management.sendTransactionDescription"),
          confirmButtonLabel:
            options.confirmButtonLabel ?? t("DashboardIssuance.management.goAhead"),
          submitToast:
            options.submitToast ??
            t("DashboardIssuance.management.submittingAction", {
              action: input.label.toLowerCase(),
            }),
          successToast:
            options.successToast ?? t("DashboardIssuance.management.transactionFinalized"),
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
