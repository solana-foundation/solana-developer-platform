"use client";

import { privateChannelInstanceInputSchema, SANDBOX_DEFAULTS } from "@sdp/private-channels";
import type {
  PrivateChannelInstance,
  PrivateChannelInstanceInput,
  PrivateChannelProbeResult,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useReducer, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { privateChannelsInstancePath } from "../private-channels-routes";
import {
  type ConnectPrivateChannelResult,
  connectPrivateChannelAction,
  type FieldErrors,
  testConnectionAction,
  updatePrivateChannelAction,
} from "./actions";
import { isProjectRpcProbeFailure } from "./probe-error";

export type ConnectFormValues = Omit<PrivateChannelInstanceInput, "chainRpcUrl">;

const FORM_PREFILL: ConnectFormValues = {
  gatewayUrl: SANDBOX_DEFAULTS.gatewayUrl,
  escrowProgramId: SANDBOX_DEFAULTS.escrowProgramId,
  withdrawProgramId: SANDBOX_DEFAULTS.withdrawProgramId,
  escrowInstanceAddr: SANDBOX_DEFAULTS.escrowInstanceAddr,
  authUrl: SANDBOX_DEFAULTS.authUrl,
};

function toValues(instance: PrivateChannelInstance | null): ConnectFormValues {
  if (!instance) return { ...FORM_PREFILL };
  return {
    gatewayUrl: instance.gatewayUrl,
    escrowProgramId: instance.escrowProgramId,
    withdrawProgramId: instance.withdrawProgramId,
    escrowInstanceAddr: instance.escrowInstanceAddr,
    authUrl: instance.authUrl,
  };
}

export interface ReactivatePrompt {
  existing: PrivateChannelInstance;
  message: string;
}

interface ConnectFormState {
  instance: PrivateChannelInstance | null;
  values: ConnectFormValues;
  errors: FieldErrors;
  formError: string | null;
  reactivatePrompt: ReactivatePrompt | null;
}

type ConnectFormUpdate =
  | Partial<ConnectFormState>
  | ((state: ConnectFormState) => Partial<ConnectFormState>);

function connectFormReducer(state: ConnectFormState, update: ConnectFormUpdate): ConnectFormState {
  const patch = typeof update === "function" ? update(state) : update;
  return { ...state, ...patch };
}

type Translate = ReturnType<typeof useTranslations>;

function probeFailureMessage(t: Translate, probe: PrivateChannelProbeResult): string {
  return isProjectRpcProbeFailure(probe)
    ? t("DashboardPrivateChannels.instance.projectRpcTestFailed")
    : t("DashboardPrivateChannels.instance.connectionTestFailed");
}

/**
 * The connect form's state and actions: its values and their validation, and the test,
 * connect and update requests with how each outcome lands (field errors, a form error, a
 * reactivation prompt, or the saved instance). The component that renders it holds no logic.
 */
export function useConnectForm({
  initialInstance,
  stayOnPageAfterConnect,
  onSuccess,
}: {
  initialInstance: PrivateChannelInstance | null;
  /** Keep embedded connection management on its current page after reactivation. */
  stayOnPageAfterConnect: boolean;
  onSuccess?: () => void;
}) {
  const [state, updateState] = useReducer(connectFormReducer, {
    instance: initialInstance,
    values: toValues(initialInstance),
    errors: {},
    formError: null,
    reactivatePrompt: null,
  });
  const [isTesting, startTesting] = useTransition();
  const [isConnecting, startConnecting] = useTransition();
  const [isUpdating, startUpdating] = useTransition();
  const t = useTranslations();
  const router = useRouter();
  const { instance, values, errors, formError, reactivatePrompt } = state;

  const initiallyConnected = initialInstance?.isActive === true;
  const busy = isTesting || isConnecting || isUpdating;

  const parsed = useMemo(() => privateChannelInstanceInputSchema.safeParse(values), [values]);
  const isValid = parsed.success;

  const update = <K extends keyof ConnectFormValues>(key: K, value: ConnectFormValues[K]) => {
    updateState((current) => ({
      values: { ...current.values, [key]: value },
      errors: { ...current.errors, [key]: undefined },
      formError: null,
    }));
  };

  const applyConnectResult = (result: ConnectPrivateChannelResult) => {
    if (result.ok) {
      updateState({
        instance: result.instance,
        values: toValues(result.instance),
        errors: {},
        formError: null,
      });
      toast.success(t("DashboardPrivateChannels.instance.connectSuccess"));
      onSuccess?.();
      if (stayOnPageAfterConnect) {
        router.refresh();
      } else {
        // Match other integrations: successful setup returns to the provider detail.
        router.push(privateChannelsInstancePath(result.instance.id));
      }
      return;
    }
    if (result.kind === "validation") {
      updateState({ errors: result.fieldErrors, formError: null });
      return;
    }
    if (result.kind === "probe") {
      updateState({ formError: probeFailureMessage(t, result.probe) });
      return;
    }
    if (result.kind === "requires-reactivate-confirmation") {
      updateState({
        reactivatePrompt: { existing: result.existingInstance, message: result.message },
      });
      return;
    }
    if (result.kind === "conflict-active") {
      // Shouldn't hit unless another tab connected concurrently — reflect state and stop.
      updateState({
        instance: result.activeInstance,
        values: toValues(result.activeInstance),
      });
      toast.error(result.message);
      return;
    }
    // `server` carries the API's own message (RPC resolution, principal
    // provisioning, feature gate). Surface it like runUpdate does — the generic
    // fallback named a connection test that never ran and hid the real failure.
    updateState({ formError: result.message });
  };

  const runTest = () => {
    startTesting(async () => {
      const result = await testConnectionAction({
        gatewayUrl: values.gatewayUrl,
        authUrl: values.authUrl,
        escrowProgramId: values.escrowProgramId,
        escrowInstanceAddr: values.escrowInstanceAddr,
      });
      if (result.kind === "validation") {
        updateState((current) => ({
          errors: { ...current.errors, ...result.fieldErrors },
          formError: null,
        }));
        return;
      }
      if (result.kind === "request-error") {
        // The request never produced a probe verdict, so there are no per-check
        // badges to show — but the reason still belongs on screen.
        toast.error(result.message);
        return;
      }
      if (result.probe.ok) {
        toast.success(t("DashboardPrivateChannels.instance.connectionTestSuccess"));
      } else {
        toast.error(probeFailureMessage(t, result.probe));
      }
    });
  };

  const runConnect = (confirmReactivate = false) => {
    startConnecting(async () => {
      const result = await connectPrivateChannelAction({ ...values, confirmReactivate });
      applyConnectResult(result);
    });
  };

  const runUpdate = () => {
    if (!instance) return;
    startUpdating(async () => {
      const result = await updatePrivateChannelAction({ ...values, instanceId: instance.id });
      if (result.ok) {
        updateState({
          instance: result.instance,
          values: toValues(result.instance),
          errors: {},
          formError: null,
        });
        toast.success(t("DashboardPrivateChannels.instance.updateSuccess"));
        onSuccess?.();
        router.refresh();
        return;
      }
      if (result.kind === "validation") {
        updateState({ errors: result.fieldErrors, formError: null });
        return;
      }
      if (result.kind === "probe") {
        updateState({ formError: probeFailureMessage(t, result.probe) });
        return;
      }
      updateState({ formError: result.message });
    });
  };

  const dismissReactivatePrompt = () => updateState({ reactivatePrompt: null });
  const confirmReactivate = () => {
    updateState({ reactivatePrompt: null });
    runConnect(true);
  };

  return {
    instance,
    values,
    errors,
    formError,
    reactivatePrompt,
    initiallyConnected,
    busy,
    isTesting,
    isConnecting,
    isUpdating,
    isValid,
    update,
    runTest,
    runConnect,
    runUpdate,
    dismissReactivatePrompt,
    confirmReactivate,
  };
}
