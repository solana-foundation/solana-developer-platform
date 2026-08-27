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
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { PRIVATE_CHANNELS_INTEGRATION_PATH } from "../private-channels-routes";
import {
  type ConnectPrivateChannelResult,
  connectPrivateChannelAction,
  deletePrivateChannelAction,
  disconnectPrivateChannelAction,
  type FieldErrors,
  testConnectionAction,
} from "./actions";

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
}

const GATEWAY_DOT: Record<"ready" | "degraded" | "unreachable", string> = {
  ready: "bg-status-success-text",
  degraded: "bg-status-warning-text",
  unreachable: "bg-status-error-text",
};
const GATEWAY_TEXT: Record<"ready" | "degraded" | "unreachable", string> = {
  ready: "text-status-success-text",
  degraded: "text-status-warning-text",
  unreachable: "text-status-error-text",
};

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
  gatewayResult: ConnectionProbeResult["gateway"] | null;
  authResult: ConnectionProbeResult["auth"] | null;
  reactivatePrompt: { existing: PrivateChannelInstance; message: string } | null;
  showDelete: boolean;
}

type ConnectFormUpdate =
  | Partial<ConnectFormState>
  | ((state: ConnectFormState) => Partial<ConnectFormState>);

function connectFormReducer(state: ConnectFormState, update: ConnectFormUpdate): ConnectFormState {
  const patch = typeof update === "function" ? update(state) : update;
  return { ...state, ...patch };
}

export function PrivateChannelsConnectForm({ initialInstance }: Props) {
  const [state, updateState] = useReducer(connectFormReducer, {
    instance: initialInstance,
    values: toValues(initialInstance),
    errors: {},
    formError: null,
    gatewayResult: null,
    authResult: null,
    reactivatePrompt: null,
    showDelete: false,
  });
  const [isTesting, startTesting] = useTransition();
  const [isConnecting, startConnecting] = useTransition();
  const [isDisconnecting, startDisconnecting] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const t = useTranslations();
  const router = useRouter();
  const {
    instance,
    values,
    errors,
    formError,
    gatewayResult,
    authResult,
    reactivatePrompt,
    showDelete,
  } = state;

  const isLocked = instance?.isActive === true;
  const busy = isTesting || isConnecting || isDisconnecting || isDeleting;

  const parsed = useMemo(() => privateChannelInstanceInputSchema.safeParse(values), [values]);
  const isValid = parsed.success;

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    if (isLocked) return;
    // Any edit invalidates the last probe result.
    updateState((current) => ({
      values: { ...current.values, [key]: value },
      errors: { ...current.errors, [key]: undefined },
      formError: null,
      gatewayResult: null,
      authResult: null,
    }));
  };

  const applyConnectResult = (result: ConnectPrivateChannelResult) => {
    if (result.ok) {
      updateState({
        instance: result.instance,
        values: toValues(result.instance),
        errors: {},
        formError: null,
        gatewayResult: null,
        authResult: null,
      });
      toast.success(t("DashboardPrivateChannels.instance.connectSuccess"));
      // Match other integrations: successful setup returns to the provider detail.
      router.push(PRIVATE_CHANNELS_INTEGRATION_PATH);
      return;
    }
    if (result.kind === "validation") {
      updateState({ errors: result.fieldErrors, formError: null });
      return;
    }
    if (result.kind === "probe") {
      updateState({
        gatewayResult: result.probe.gateway,
        authResult: result.probe.auth,
        formError: t("DashboardPrivateChannels.instance.connectionTestFailed"),
      });
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
    updateState({ formError: t("DashboardPrivateChannels.instance.connectionRequestFailed") });
  };

  const runTest = () => {
    startTesting(async () => {
      const result = await testConnectionAction({
        gatewayUrl: values.gatewayUrl,
        authUrl: values.authUrl,
      });
      if (result.kind === "validation") {
        updateState((current) => ({
          errors: { ...current.errors, ...result.fieldErrors },
          formError: null,
        }));
        return;
      }
      if (result.kind === "request-error") {
        updateState({
          errors: {},
          gatewayResult: null,
          authResult: null,
          formError: t("DashboardPrivateChannels.instance.connectionRequestFailed"),
        });
        return;
      }
      updateState({
        errors: {},
        gatewayResult: result.probe.gateway,
        authResult: result.probe.auth,
        formError: result.probe.ok
          ? null
          : t("DashboardPrivateChannels.instance.connectionTestFailed"),
      });
    });
  };

  const runConnect = (confirmReactivate = false) => {
    startConnecting(async () => {
      const result = await connectPrivateChannelAction({ ...values, confirmReactivate });
      applyConnectResult(result);
    });
  };

  const runDisconnect = () => {
    startDisconnecting(async () => {
      const result = await disconnectPrivateChannelAction();
      if (result.ok) {
        updateState({ instance: result.instance, values: toValues(result.instance) });
        toast.success(t("DashboardPrivateChannels.instance.disconnectSuccess"));
      } else {
        toast.error(result.message);
      }
    });
  };

  const runDelete = () => {
    startDeleting(async () => {
      const result = await deletePrivateChannelAction();
      if (result.ok) {
        updateState({
          instance: null,
          values: { ...FORM_PREFILL },
          gatewayResult: null,
          authResult: null,
          formError: null,
          showDelete: false,
        });
        toast.success(t("DashboardPrivateChannels.instance.deleteSuccess"));
        router.push(PRIVATE_CHANNELS_INTEGRATION_PATH);
      } else {
        toast.error(result.message);
      }
    });
  };

  return (
    <div className="grid gap-6">
      <UrlField
        id="gateway-url"
        label={t("DashboardPrivateChannels.instance.gatewayUrl")}
        placeholder={t("DashboardPrivateChannels.instance.gatewayPlaceholder")}
        value={values.gatewayUrl}
        error={errors.gatewayUrl}
        disabled={isLocked}
        onChange={(v) => update("gatewayUrl", v)}
        status={gatewayStatus(t, gatewayResult)}
      />

      <UrlField
        id="auth-url"
        label={t("DashboardPrivateChannels.instance.authUrl")}
        placeholder={t("DashboardPrivateChannels.instance.authPlaceholder")}
        value={values.authUrl}
        error={errors.authUrl}
        disabled={isLocked}
        onChange={(v) => update("authUrl", v)}
        status={authStatus(t, authResult)}
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <TextField
          id="escrow-program-id"
          label={t("DashboardPrivateChannels.instance.escrowProgramId")}
          value={values.escrowProgramId}
          error={errors.escrowProgramId}
          disabled={isLocked}
          onChange={(v) => update("escrowProgramId", v)}
        />
        <TextField
          id="withdraw-program-id"
          label={t("DashboardPrivateChannels.instance.withdrawProgramId")}
          value={values.withdrawProgramId}
          error={errors.withdrawProgramId}
          disabled={isLocked}
          onChange={(v) => update("withdrawProgramId", v)}
        />
      </div>

      <TextField
        id="escrow-instance-addr"
        label={t("DashboardPrivateChannels.instance.escrowInstanceAddr")}
        value={values.escrowInstanceAddr}
        error={errors.escrowInstanceAddr}
        disabled={isLocked}
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

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          className="min-w-36"
          onClick={runTest}
          disabled={busy || isLocked}
        >
          {isTesting
            ? t("DashboardPrivateChannels.instance.testing")
            : t("DashboardPrivateChannels.instance.testConnection")}
        </Button>
        {isLocked ? (
          <>
            <Button
              type="button"
              variant="destructive"
              onClick={() => updateState({ showDelete: true })}
              disabled={busy}
            >
              {t("DashboardPrivateChannels.instance.delete")}
            </Button>
            <Button type="button" onClick={runDisconnect} disabled={busy}>
              {isDisconnecting
                ? t("DashboardPrivateChannels.instance.disconnecting")
                : t("DashboardPrivateChannels.instance.disconnect")}
            </Button>
          </>
        ) : (
          <Button type="button" onClick={() => runConnect(false)} disabled={!isValid || busy}>
            {isConnecting
              ? t("DashboardPrivateChannels.instance.connecting")
              : t("DashboardPrivateChannels.instance.connect")}
          </Button>
        )}
      </div>

      <ReactivateConfirmationDialog
        prompt={reactivatePrompt}
        working={isConnecting}
        onCancel={() => updateState({ reactivatePrompt: null })}
        onConfirm={() => {
          updateState({ reactivatePrompt: null });
          runConnect(true);
        }}
      />

      <DeleteConfirmationDialog
        isOpen={showDelete}
        working={isDeleting}
        gatewayUrl={instance?.gatewayUrl ?? ""}
        onCancel={() => updateState({ showDelete: false })}
        onConfirm={runDelete}
      />
    </div>
  );
}

type Translate = ReturnType<typeof useTranslations>;

function gatewayStatus(
  t: Translate,
  gatewayResult: ConnectionProbeResult["gateway"] | null
): StatusIndicator | null {
  if (!gatewayResult) return null;
  return {
    label:
      gatewayResult.status === "ready"
        ? t("DashboardPrivateChannels.instance.statusReady")
        : gatewayResult.status === "degraded"
          ? t("DashboardPrivateChannels.instance.statusDegraded")
          : t("DashboardPrivateChannels.instance.statusUnreachable"),
    dotClass: GATEWAY_DOT[gatewayResult.status],
    textClass: GATEWAY_TEXT[gatewayResult.status],
    detail:
      gatewayResult.status === "ready"
        ? t("DashboardPrivateChannels.instance.latency", { ms: gatewayResult.latencyMs })
        : gatewayResult.status === "degraded"
          ? t("DashboardPrivateChannels.instance.gatewayNotReady")
          : undefined,
  };
}

function authStatus(
  t: Translate,
  authResult: ConnectionProbeResult["auth"] | null
): StatusIndicator | null {
  if (!authResult) return null;
  if (authResult.ok) {
    return {
      label: t("DashboardPrivateChannels.instance.statusReady"),
      dotClass: GATEWAY_DOT.ready,
      textClass: GATEWAY_TEXT.ready,
      detail: t("DashboardPrivateChannels.instance.latency", { ms: authResult.latencyMs }),
    };
  }
  return {
    label: t("DashboardPrivateChannels.instance.statusFailed"),
    dotClass: GATEWAY_DOT.unreachable,
    textClass: GATEWAY_TEXT.unreachable,
  };
}

interface StatusIndicator {
  label: string;
  dotClass: string;
  textClass: string;
  detail?: string;
}

function Status({ status }: { status?: StatusIndicator | null }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm",
        status.textClass
      )}
    >
      <span
        aria-hidden="true"
        className={cn("inline-block size-2 rounded-full", status.dotClass)}
      />
      <span>{status.label}</span>
      {status.detail ? <span className="text-secondary">· {status.detail}</span> : null}
    </span>
  );
}

function UrlField(props: {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  error?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  status?: StatusIndicator | null;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <Label htmlFor={props.id}>{props.label}</Label>
        <Status status={props.status} />
      </div>
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

function DeleteConfirmationDialog(props: {
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
