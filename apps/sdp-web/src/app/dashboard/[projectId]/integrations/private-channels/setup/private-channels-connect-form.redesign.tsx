"use client";

import type { PrivateChannelInstance } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import {
  PRIVATE_CHANNELS_INTEGRATION_PATH,
  privateChannelsInstancePath,
} from "../private-channels-routes";
import { ReactivateConfirmationDialog } from "./private-channels-confirmation-dialogs";
import { useConnectForm } from "./use-connect-form";

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

/**
 * The refresh Privacy page's footer: Test connection on the left; Cancel and the commit
 * (Connect, or Update once connected) on the right. A commit that cannot run yet is drawn
 * outlined, as the design does.
 */
function RefreshSetupFooter({
  onTest,
  testing,
  onCancel,
  commit,
  canCommit,
  busy,
}: {
  onTest?: () => void;
  testing: boolean;
  onCancel: () => void;
  commit: { kind: "connect" | "update"; working: boolean; onClick: () => void };
  canCommit: boolean;
  busy: boolean;
}) {
  const t = useTranslations();
  const commitLabel =
    commit.kind === "update"
      ? commit.working
        ? t("DashboardPrivateChannels.instance.updating")
        : t("DashboardPrivateChannels.instance.update")
      : commit.working
        ? t("DashboardPrivateChannels.instance.connecting")
        : t("DashboardPrivateChannels.instance.connect");
  return (
    <div className="flex items-center gap-2">
      {onTest ? (
        <Button type="button" variant="outline" onClick={onTest} disabled={busy}>
          {testing
            ? t("DashboardPrivateChannels.instance.testing")
            : t("DashboardPrivateChannels.instance.testConnection")}
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("DashboardPrivateChannels.common.cancel")}
        </Button>
        <Button
          type="button"
          variant={canCommit ? "default" : "outline"}
          onClick={commit.onClick}
          disabled={!canCommit || busy}
        >
          {commitLabel}
        </Button>
      </div>
    </div>
  );
}

/** The embedded and legacy layouts' buttons: Test connection, then Connect or Update. */
function ActionButtons({
  showTestAction,
  form,
}: {
  showTestAction: boolean;
  form: ReturnType<typeof useConnectForm>;
}) {
  const t = useTranslations();
  const { busy, isValid, isTesting, isConnecting, isUpdating, initiallyConnected } = form;
  return (
    <>
      {showTestAction ? (
        <Button
          type="button"
          variant="secondary"
          className="min-w-36"
          onClick={form.runTest}
          disabled={busy}
        >
          {isTesting
            ? t("DashboardPrivateChannels.instance.testing")
            : t("DashboardPrivateChannels.instance.testConnection")}
        </Button>
      ) : null}
      {initiallyConnected ? (
        <Button type="button" onClick={form.runUpdate} disabled={!isValid || busy}>
          {isUpdating
            ? t("DashboardPrivateChannels.instance.updating")
            : t("DashboardPrivateChannels.instance.update")}
        </Button>
      ) : (
        <Button type="button" onClick={() => form.runConnect(false)} disabled={!isValid || busy}>
          {isConnecting
            ? t("DashboardPrivateChannels.instance.connecting")
            : t("DashboardPrivateChannels.instance.connect")}
        </Button>
      )}
    </>
  );
}

export function PrivateChannelsConnectForm({
  initialInstance,
  stayOnPageAfterConnect = false,
  showTestAction = true,
  pageLayout = false,
  onSuccess,
}: Props) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const refresh = useThemeScope() === "refresh";
  const form = useConnectForm({ initialInstance, stayOnPageAfterConnect, onSuccess });
  const {
    instance,
    values,
    errors,
    formError,
    busy,
    isValid,
    initiallyConnected,
    isTesting,
    isConnecting,
    isUpdating,
    update,
    runTest,
    runConnect,
    runUpdate,
  } = form;

  const endpointFields = (
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
    </>
  );

  const programFields = (
    <>
      <div className="grid gap-2 sm:grid-cols-2 refresh:gap-6 refresh:sm:grid-cols-1">
        <TextField
          id="escrow-program-id"
          label={t("DashboardPrivateChannels.instance.escrowProgramId")}
          placeholder={t("DashboardPrivateChannels.instance.programAddressPlaceholder")}
          value={values.escrowProgramId}
          error={errors.escrowProgramId}
          disabled={busy}
          large={pageLayout}
          onChange={(v) => update("escrowProgramId", v)}
        />
        <TextField
          id="withdraw-program-id"
          label={t("DashboardPrivateChannels.instance.withdrawProgramId")}
          placeholder={t("DashboardPrivateChannels.instance.programAddressPlaceholder")}
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
        placeholder={t("DashboardPrivateChannels.instance.accountAddressPlaceholder")}
        value={values.escrowInstanceAddr}
        error={errors.escrowInstanceAddr}
        disabled={busy}
        large={pageLayout}
        onChange={(v) => update("escrowInstanceAddr", v)}
      />
    </>
  );

  const formErrorAlert = (
    <>
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

  const fields = (
    <>
      {endpointFields}
      {programFields}
      {formErrorAlert}
    </>
  );

  const actionButtons = <ActionButtons showTestAction={showTestAction} form={form} />;

  const confirmationDialogs = (
    <ReactivateConfirmationDialog
      prompt={form.reactivatePrompt}
      working={isConnecting}
      onCancel={form.dismissReactivatePrompt}
      onConfirm={form.confirmReactivate}
    />
  );

  if (pageLayout) {
    const cancelPath = instance
      ? privateChannelsInstancePath(instance.id)
      : PRIVATE_CHANNELS_INTEGRATION_PATH;

    if (refresh) {
      // The refresh Privacy page: one form in two sections, no step header; Test connection
      // on the footer's left, the commit on its right.
      return (
        <WizardFrame
          steps={[{ label: t("DashboardPrivateChannels.instance.setupStepLabel"), title: "" }]}
          currentStep={0}
          progressLabel={t("DashboardPrivateChannels.instance.setupStepProgress")}
          hideProgress
          footer={
            <RefreshSetupFooter
              onTest={showTestAction ? runTest : undefined}
              testing={isTesting}
              onCancel={() => router.push(href(cancelPath))}
              commit={
                initiallyConnected
                  ? { kind: "update", working: isUpdating, onClick: runUpdate }
                  : { kind: "connect", working: isConnecting, onClick: () => runConnect(false) }
              }
              canCommit={isValid}
              busy={busy}
            />
          }
        >
          <div className="space-y-12">
            <section className="space-y-6">
              <h2 className="text-body font-medium text-primary">
                {t("DashboardPrivateChannels.instance.endpointsSection")}
              </h2>
              {endpointFields}
            </section>
            <section className="space-y-6">
              <h2 className="text-body font-medium text-primary">
                {t("DashboardPrivateChannels.instance.programsSection")}
              </h2>
              {programFields}
            </section>
            {formErrorAlert}
          </div>
          {confirmationDialogs}
        </WizardFrame>
      );
    }

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
              onClick={() => router.push(href(cancelPath))}
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
