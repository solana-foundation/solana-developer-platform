"use client";

import {
  type ConnectionProbeResult,
  privateChannelInstanceInputSchema,
  SANDBOX_DEFAULTS,
} from "@sdp/private-channels";
import type { PrivateChannelInstance, PrivateChannelInstanceInput } from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  type ConnectPrivateChannelResult,
  connectPrivateChannelAction,
  deletePrivateChannelAction,
  disconnectPrivateChannelAction,
  type FieldErrors,
  testConnectionAction,
} from "./actions";

type FormValues = PrivateChannelInstanceInput;

/**
 * Sandbox prefill for the connect form. `chainRpcUrl` is deliberately blank:
 * SANDBOX_DEFAULTS carries a documented placeholder (`?api-key=XXXXXXX`) rather than
 * a working endpoint, so prefilling it guarantees a failed probe on first Connect and
 * hides the field's own placeholder. The operator supplies their own keyed RPC URL.
 */
const FORM_PREFILL: FormValues = { ...SANDBOX_DEFAULTS, chainRpcUrl: "" };

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
    chainRpcUrl: instance.chainRpcUrl,
    escrowProgramId: instance.escrowProgramId,
    withdrawProgramId: instance.withdrawProgramId,
    escrowInstanceAddr: instance.escrowInstanceAddr,
    authUrl: instance.authUrl,
  };
}

export function PrivateChannelsConnectForm({ initialInstance }: Props) {
  const [instance, setInstance] = useState<PrivateChannelInstance | null>(initialInstance);
  const [values, setValues] = useState<FormValues>(() => toValues(initialInstance));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [gatewayResult, setGatewayResult] = useState<ConnectionProbeResult["gateway"] | null>(null);
  const [rpcResult, setRpcResult] = useState<ConnectionProbeResult["rpc"] | null>(null);
  const [authResult, setAuthResult] = useState<ConnectionProbeResult["auth"] | null>(null);
  const [isTesting, startTesting] = useTransition();
  const [isConnecting, startConnecting] = useTransition();
  const [isDisconnecting, startDisconnecting] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const [reactivatePrompt, setReactivatePrompt] = useState<{
    existing: PrivateChannelInstance;
    message: string;
  } | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const t = useTranslations();

  const isLocked = instance?.isActive === true;
  const busy = isTesting || isConnecting || isDisconnecting || isDeleting;

  const parsed = useMemo(() => privateChannelInstanceInputSchema.safeParse(values), [values]);
  const isValid = parsed.success;

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    if (isLocked) return;
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    // Any edit invalidates the last probe result.
    setGatewayResult(null);
    setRpcResult(null);
    setAuthResult(null);
  };

  const applyConnectResult = (result: ConnectPrivateChannelResult) => {
    if (result.ok) {
      setInstance(result.instance);
      setValues(toValues(result.instance));
      setErrors({});
      setGatewayResult(null);
      setRpcResult(null);
      setAuthResult(null);
      toast.success(t("DashboardPrivateChannels.instance.connectSuccess"));
      return;
    }
    if (result.kind === "validation") {
      setErrors(result.fieldErrors);
      return;
    }
    if (result.kind === "probe") {
      setGatewayResult(result.probe.gateway);
      setRpcResult(result.probe.rpc);
      setAuthResult(result.probe.auth);
      toast.error(result.message);
      return;
    }
    if (result.kind === "requires-reactivate-confirmation") {
      setReactivatePrompt({ existing: result.existingInstance, message: result.message });
      return;
    }
    if (result.kind === "conflict-active") {
      // Shouldn't hit unless another tab connected concurrently — reflect state and stop.
      setInstance(result.activeInstance);
      setValues(toValues(result.activeInstance));
      toast.error(result.message);
      return;
    }
    toast.error(result.message);
  };

  const runTest = () => {
    startTesting(async () => {
      const result = await testConnectionAction({
        gatewayUrl: values.gatewayUrl,
        chainRpcUrl: values.chainRpcUrl,
        authUrl: values.authUrl,
      });
      setGatewayResult(result.gateway);
      setRpcResult(result.rpc);
      setAuthResult(result.auth);
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
        setInstance(result.instance);
        setValues(toValues(result.instance));
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
        setInstance(null);
        setValues({ ...FORM_PREFILL });
        setGatewayResult(null);
        setRpcResult(null);
        setAuthResult(null);
        setShowDelete(false);
        toast.success(t("DashboardPrivateChannels.instance.deleteSuccess"));
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
        id="chain-rpc-url"
        label={t("DashboardPrivateChannels.instance.chainRpcUrl")}
        placeholder={t("DashboardPrivateChannels.instance.chainRpcPlaceholder")}
        value={values.chainRpcUrl}
        error={errors.chainRpcUrl}
        disabled={isLocked}
        onChange={(v) => update("chainRpcUrl", v)}
        status={rpcStatus(t, rpcResult)}
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

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={runTest} disabled={busy || isLocked}>
          {isTesting
            ? t("DashboardPrivateChannels.instance.testing")
            : t("DashboardPrivateChannels.instance.testConnection")}
        </Button>
        {isLocked ? (
          <>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setShowDelete(true)}
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
        onCancel={() => setReactivatePrompt(null)}
        onConfirm={() => {
          setReactivatePrompt(null);
          runConnect(true);
        }}
      />

      <DeleteConfirmationDialog
        isOpen={showDelete}
        working={isDeleting}
        gatewayUrl={instance?.gatewayUrl ?? ""}
        onCancel={() => setShowDelete(false)}
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
          ? gatewayResult.reason
          : gatewayResult.error,
  };
}

function rpcStatus(
  t: Translate,
  rpcResult: ConnectionProbeResult["rpc"] | null
): StatusIndicator | null {
  if (!rpcResult) return null;
  if (rpcResult.ok) {
    return {
      label: t("DashboardPrivateChannels.instance.statusReady"),
      dotClass: GATEWAY_DOT.ready,
      textClass: GATEWAY_TEXT.ready,
      detail: t("DashboardPrivateChannels.instance.latencyWithVersion", {
        ms: rpcResult.latencyMs,
        version: rpcResult.version,
      }),
    };
  }
  return {
    label: t("DashboardPrivateChannels.instance.statusFailed"),
    dotClass: GATEWAY_DOT.unreachable,
    textClass: GATEWAY_TEXT.unreachable,
    detail: rpcResult.error,
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
    detail: authResult.error,
  };
}

interface StatusIndicator {
  label: string;
  dotClass: string;
  textClass: string;
  detail?: string;
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
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={props.id}>{props.label}</Label>
        {props.status ? (
          <span className={cn("inline-flex items-center gap-1.5 text-sm", props.status.textClass)}>
            <span
              aria-hidden="true"
              className={cn("inline-block size-2 rounded-full", props.status.dotClass)}
            />
            <span>{props.status.label}</span>
            {props.status.detail ? (
              <span className="text-secondary">· {props.status.detail}</span>
            ) : null}
          </span>
        ) : null}
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
      />
      {props.error ? (
        <span className="block text-sm text-status-error-text">{props.error}</span>
      ) : null}
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
      />
      {props.error ? (
        <span className="block text-sm text-status-error-text">{props.error}</span>
      ) : null}
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
