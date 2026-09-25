"use client";

import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import { Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { WizardFrame } from "@/components/wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useCounterpartyCreate } from "./counterparty-create-context";

interface CounterpartyCreatePageProps {
  embedded?: boolean;
  onCancel?: () => void;
}

/** A labelled field: the label, an optional "optional" word and a hint on one line. */
function Field({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id?: string;
  label: string;
  optional?: string;
  hint: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="text-tertiary">{optional}</span> : null}
        <InfoHint text={hint} />
      </Label>
      {children}
      {error ? <p className="text-meta text-error">{error}</p> : null}
    </div>
  );
}

/**
 * The design's one contact form: type, name, a first wallet address and your own reference.
 * The address is optional; a filled one is screened and attached once the contact exists.
 */
function CounterpartyForm() {
  const t = useTranslations();
  const { basics, submitError } = useCounterpartyCreate();
  const { values, setField, errors } = basics;

  return (
    <div className="space-y-6">
      <Field
        label={t("DashboardPayments.counterparty.type")}
        hint={t("DashboardPayments.counterparty.typeHint")}
      >
        <SegmentedControl
          ariaLabel={t("DashboardPayments.counterparty.type")}
          className="w-fit"
          value={values.entityType}
          onChange={(next) => {
            const type = COUNTERPARTY_ENTITY_TYPES.find((candidate) => candidate === next);
            if (type) setField("entityType", type);
          }}
          options={COUNTERPARTY_ENTITY_TYPES.map((type) => ({
            value: type,
            label: t(`DashboardPayments.counterparty.${type}` as MessageKey),
          }))}
        />
      </Field>

      <Field
        id="displayName"
        label={t("DashboardPayments.counterparty.nameLabel")}
        hint={t("DashboardPayments.counterparty.nameHint")}
        error={errors.displayName}
      >
        <Input
          size="xl"
          id="displayName"
          placeholder={t(
            values.entityType === "individual"
              ? "DashboardPayments.counterparty.individualNamePlaceholder"
              : "DashboardPayments.counterparty.businessNamePlaceholder"
          )}
          value={values.displayName}
          onChange={(event) => setField("displayName", event.target.value)}
        />
      </Field>

      <Field
        id="walletAddress"
        label={t("DashboardPayments.counterparty.walletAddress")}
        hint={t("DashboardPayments.counterparty.walletAddressHint")}
        error={errors.walletAddress}
      >
        <Input
          size="xl"
          id="walletAddress"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("DashboardPayments.counterparty.walletAddressPlaceholder")}
          value={values.walletAddress}
          onChange={(event) => setField("walletAddress", event.target.value)}
        />
      </Field>

      <Field
        id="externalId"
        label={t("DashboardPayments.counterparty.externalId")}
        optional={t("DashboardPayments.counterparty.optionalWord")}
        hint={t("DashboardPayments.counterparty.externalIdHint")}
        error={errors.externalId}
      >
        <Input
          size="xl"
          id="externalId"
          placeholder={t("DashboardPayments.counterparty.externalIdPlaceholder")}
          value={values.externalId}
          onChange={(event) => setField("externalId", event.target.value)}
        />
      </Field>

      {submitError ? <p className="text-body text-error">{submitError}</p> : null}
    </div>
  );
}

/** Asks whether to attach an address the screening flagged, or could not screen. */
function FlaggedAddressDialog() {
  const t = useTranslations();
  const { flaggedAddress, submitting, attachFlaggedAddress, skipFlaggedAddress } =
    useCounterpartyCreate();
  return (
    <Modal
      isOpen={flaggedAddress !== null}
      ariaLabel={t("DashboardPayments.counterparty.addAnywayTitle")}
      onClose={skipFlaggedAddress}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-subheading font-medium text-primary">
            {t("DashboardPayments.counterparty.addAnywayTitle")}
          </h2>
          <p className="text-body text-secondary">{flaggedAddress?.message}</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={skipFlaggedAddress}
          >
            {t("DashboardPayments.counterparty.skipAddress")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            iconLeft={<ShieldAlertIcon />}
            onClick={() => void attachFlaggedAddress()}
          >
            {t("DashboardPayments.counterparty.addAnyway")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CounterpartyCreatePage({
  embedded = false,
  onCancel,
}: CounterpartyCreatePageProps) {
  const t = useTranslations();
  const router = useRouter();
  const { submit, submitting, flaggedAddress } = useCounterpartyCreate();

  const cancel = onCancel ?? (() => router.push("/dashboard/payments/counterparty"));
  // Once the contact exists, a second submit would create it again.
  const busy = submitting || flaggedAddress !== null;

  const content = (
    <div className="space-y-6">
      <CounterpartyForm />
      <FlaggedAddressDialog />
    </div>
  );

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
        {t("DashboardPayments.counterparty.cancel")}
      </Button>
      <Button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
      >
        {submitting
          ? t("DashboardPayments.counterparty.adding")
          : t("DashboardPayments.counterparty.addToContacts")}
      </Button>
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-6">
        <h2 className="text-heading font-medium text-primary">
          {t("Shared.dashboardShell.newCounterparty")}
        </h2>
        {content}
        {footer}
      </div>
    );
  }

  // The page title and its way back come from the shell's header; the frame adds only the
  // form's column and the footer band.
  return (
    <WizardFrame
      steps={[{ label: t("DashboardPayments.counterparty.basics"), title: "" }]}
      currentStep={0}
      hideProgress
      progressLabel={t("DashboardPayments.counterparty.stepProgress", { current: 1, total: 1 })}
      footer={footer}
    >
      {content}
    </WizardFrame>
  );
}
