"use client";

import {
  type ConnectionProbeResult,
  privateChannelInstanceInputSchema,
  SANDBOX_DEFAULTS,
} from "@sdp/private-channels";
import type { PrivateChannelInstance, PrivateChannelInstanceInput } from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useReducer, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import {
  PRIVATE_CHANNELS_INTEGRATION_PATH,
  privateChannelsInstancePath,
} from "../private-channels-routes";
import {
  type ConnectPrivateChannelResult,
  connectPrivateChannelAction,
  type FieldErrors,
  testConnectionAction,
  updatePrivateChannelAction,
} from "./actions";
import { isProjectRpcProbeFailure } from "./probe-error";

type FormValues = Omit<PrivateChannelInstanceInput, "chainRpcUrl">;

const FORM_PREFILL: FormValues = {
  gatewayUrl: SANDBOX_DEFAULTS.gatewayUrl,
  escrowProgramId: SANDBOX_DEFAULTS.escrowProgramId,
  withdrawProgramId: SANDBOX_DEFAULTS.withdrawProgramId,
  escrowInstanceAddr: SANDBOX_DEFAULTS.escrowInstanceAddr,
  authUrl: SANDBOX_DEFAULTS.authUrl,
};

interface Props {
  initialInstance: PrivateChannelInstance | null;
  /** Keep embedded connection management on its current page after reactivation. */
  stayOnPageAfterConnect?: boolean;
  /** First-time setup can probe independently; existing connections probe when saved. */
  showTestAction?: boolean;
  /** Match the full-page Payments creation flow rather than an embedded card or modal. */
  pageLayout?: boolean;
  onSuccess?: () => void;
}

function toValues(instance: PrivateChannelInstance | null): FormValues {
  if (!instance) return { ...FORM_PREFILL };
  return {
    gatewayUrl: instance.gatewayUrl,
    escrowProgramId: instance.escrowProgramId,
    withdrawProgramId: instance.withdrawProgramId,
    escrowInstanceAddr: instance.escrowInstanceAddr,
    authUrl: instance.authUrl,
  };
}

interface ConnectFormState {
  instance: PrivateChannelInstance | null;
  values: FormValues;
  errors: FieldErrors;
  formError: string | null;
  reactivatePrompt: { existing: PrivateChannelInstance; message: string } | null;
}

type ConnectFormUpdate =
  | Partial<ConnectFormState>
  | ((state: ConnectFormState) => Partial<ConnectFormState>);

function connectFormReducer(state: ConnectFormState, update: ConnectFormUpdate): ConnectFormState {
  const patch = typeof update === "function" ? update(state) : update;
  return { ...state, ...patch };
}

export function PrivateChannelsConnectForm({
  initialInstance,
  stayOnPageAfterConnect = false,
  showTestAction = true,
  pageLayout = false,
  onSuccess,
}: Props) {
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

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
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

  const fields = (
    <>
      <UrlField
        id="gateway-url"
        label={t("DashboardPrivateChannels.instance.gatewayUrl")}
        placeholder={t("DashboardPrivateChannels.instance.gatewayPlaceholder")}
        value={values.gatewayUrl}
        error={errors.gatewayUrl}
        disabled={busy}
        large={pageLayout}
        onChange={(v) => update("gatewayUrl", v)}
      />

      <UrlField
        id="auth-url"
        label={t("DashboardPrivateChannels.instance.authUrl")}
        placeholder={t("DashboardPrivateChannels.instance.authPlaceholder")}
        value={values.authUrl}
        error={errors.authUrl}
        disabled={busy}
        large={pageLayout}
        onChange={(v) => update("authUrl", v)}
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <TextField
          id="escrow-program-id"
          label={t("DashboardPrivateChannels.instance.escrowProgramId")}
          value={values.escrowProgramId}
          error={errors.escrowProgramId}
          disabled={busy}
          large={pageLayout}
          onChange={(v) => update("escrowProgramId", v)}
        />
        <TextField
          id="withdraw-program-id"
          label={t("DashboardPrivateChannels.instance.withdrawProgramId")}
          value={values.withdrawProgramId}
          error={errors.withdrawProgramId}
          disabled={busy}
          large={pageLayout}
          onChange={(v) => update("withdrawProgramId", v)}
        />
      </div>

      <TextField
        id="escrow-instance-addr"
        label={t("DashboardPrivateChannels.instance.escrowInstanceAddr")}
        value={values.escrowInstanceAddr}
        error={errors.escrowInstanceAddr}
        disabled={busy}
        large={pageLayout}
        onChange={(v) => update("escrowInstanceAddr", v)}
      />

      {formError ? (
        <div
          role="alert"
          className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error"
        >
          {formError}
        </div>
      ) : null}
    </>
  );

  const actionButtons = (
    <>
      {showTestAction ? (
        <Button
          type="button"
          variant="secondary"
          className="min-w-36"
          onClick={runTest}
          disabled={busy}
        >
          {isTesting
            ? t("DashboardPrivateChannels.instance.testing")
            : t("DashboardPrivateChannels.instance.testConnection")}
        </Button>
      ) : null}
      {initiallyConnected ? (
        <Button type="button" onClick={runUpdate} disabled={!isValid || busy}>
          {isUpdating
            ? t("DashboardPrivateChannels.instance.updating")
            : t("DashboardPrivateChannels.instance.update")}
        </Button>
      ) : (
        <Button type="button" onClick={() => runConnect(false)} disabled={!isValid || busy}>
          {isConnecting
            ? t("DashboardPrivateChannels.instance.connecting")
            : t("DashboardPrivateChannels.instance.connect")}
        </Button>
      )}
    </>
  );

  const confirmationDialogs = (
    <>
      <ReactivateConfirmationDialog
        prompt={reactivatePrompt}
        working={isConnecting}
        onCancel={() => updateState({ reactivatePrompt: null })}
        onConfirm={() => {
          updateState({ reactivatePrompt: null });
          runConnect(true);
        }}
      />
    </>
  );

  if (pageLayout) {
    const cancelPath = instance
      ? privateChannelsInstancePath(instance.id)
      : PRIVATE_CHANNELS_INTEGRATION_PATH;

    return (
      <WizardFrame
        steps={[
          {
            label: t("DashboardPrivateChannels.instance.setupStepLabel"),
            title: t("DashboardPrivateChannels.instance.setupDetailsTitle"),
          },
        ]}
        currentStep={0}
        progressLabel={t("DashboardPrivateChannels.instance.setupStepProgress")}
        description={t("DashboardPrivateChannels.instance.setupDetailsDescription")}
        maxWidthClassName="max-w-3xl"
        footer={
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push(cancelPath)}
              disabled={busy}
            >
              {t("DashboardPrivateChannels.common.cancel")}
            </Button>
            <div className="flex items-center gap-3">{actionButtons}</div>
          </div>
        }
      >
        <div className="grid gap-6 px-1 py-1">{fields}</div>
        {confirmationDialogs}
      </WizardFrame>
    );
  }

  return (
    <div className="grid gap-6">
      {fields}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{actionButtons}</div>
      {confirmationDialogs}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslations>;

function probeFailureMessage(t: Translate, probe: ConnectionProbeResult): string {
  return isProjectRpcProbeFailure(probe)
    ? t("DashboardPrivateChannels.instance.projectRpcTestFailed")
    : t("DashboardPrivateChannels.instance.connectionTestFailed");
}

function UrlField(props: {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  error?: string;
  disabled?: boolean;
  large?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        name={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
        error={props.error}
        size={props.large ? "xl" : "lg"}
      />
    </div>
  );
}

function TextField(props: {
  id: string;
  label: string;
  value: string;
  error?: string;
  disabled?: boolean;
  large?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        name={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
        error={props.error}
        size={props.large ? "xl" : "lg"}
      />
    </div>
  );
}

function ReactivateConfirmationDialog(props: {
  prompt: { existing: PrivateChannelInstance; message: string } | null;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  const isOpen = props.prompt !== null;
  return (
    <Modal
      isOpen={isOpen}
      ariaLabel={t("DashboardPrivateChannels.instance.reactivateAria")}
      onClose={props.working ? undefined : props.onCancel}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-primary">
            {t("DashboardPrivateChannels.instance.reactivateTitle")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.instance.reactivateDescription")}
          </p>
          {props.prompt ? (
            <p className="pt-2 text-sm text-secondary">
              {t("DashboardPrivateChannels.instance.gatewayLabel")}{" "}
              <span className="font-medium">{props.prompt.existing.gatewayUrl}</span>
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.working}>
            {t("DashboardPrivateChannels.common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={props.onConfirm}
            disabled={props.working}
            iconLeft={props.working ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {props.working
              ? t("DashboardPrivateChannels.instance.reactivating")
              : t("DashboardPrivateChannels.instance.reactivate")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function DeleteConfirmationDialog(props: {
  isOpen: boolean;
  working: boolean;
  gatewayUrl: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  return (
    <Modal
      isOpen={props.isOpen}
      ariaLabel={t("DashboardPrivateChannels.instance.deleteAria")}
      onClose={props.working ? undefined : props.onCancel}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-primary">
            {t("DashboardPrivateChannels.instance.deleteTitle")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.instance.deleteDescription")}
          </p>
          {props.gatewayUrl ? (
            <p className="pt-2 text-sm text-secondary">
              {t("DashboardPrivateChannels.instance.gatewayLabel")}{" "}
              <span className="font-medium">{props.gatewayUrl}</span>
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.working}>
            {t("DashboardPrivateChannels.common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.working}
            iconLeft={props.working ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {props.working
              ? t("DashboardPrivateChannels.instance.deleting")
              : t("DashboardPrivateChannels.instance.delete")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
