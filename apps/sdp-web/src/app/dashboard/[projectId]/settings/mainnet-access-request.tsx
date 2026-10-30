"use client";

import { COUNTRIES, COUNTRY_CODES, type CountryCode } from "@sdp/types/countries";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { Combobox, type ComboboxOption } from "@sdp/ui/combobox";
import { Modal } from "@sdp/ui/modal";
import { WizardStepProgress } from "@sdp/ui/wizard-step-progress";
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, type UIEvent, useCallback, useRef, useState, useTransition } from "react";
import { z } from "zod";
import { useTranslations } from "@/i18n/provider";
import { SDP_TERMS_DOCUMENT } from "@/lib/sdp-terms";
import { useZodForm } from "@/lib/use-zod-form";
import { requestMainnetAccessAction } from "./mainnet-access-actions";

const COUNTRY_OPTIONS: readonly ComboboxOption[] = COUNTRIES.map((country) => {
  const flag = regionFlagEmoji(country.code);
  return { value: country.code, label: flag ? `${flag} ${country.name}` : country.name };
});

/** How close to the end of the reader counts as read, so sub-pixel rounding never blocks it. */
const READ_TO_END_SLACK_PX = 8;

type Step = "jurisdiction" | "terms" | "sent";

/** Step 1: the picker answers with any string, so the form parses it into a known country. */
const JURISDICTION_SCHEMA = z.object({
  countryCode: z.string().nullable().pipe(z.enum(COUNTRY_CODES)),
});
/** Step 2: the admin accepts the terms on the organization's behalf. */
const TERMS_SCHEMA = z.object({ accepted: z.boolean().refine((accepted) => accepted) });

interface RequestProps {
  organizationName: string;
  termsVersion: string;
  termsUrl: string;
}

/**
 * The card body: the one-time request while the organization has none, else the recorded one
 * (`record`). It owns the dialog and stays mounted when the page refreshes to the sent request,
 * so the dialog's confirmation outlives that refresh.
 */
export function MainnetAccessRequestHost({
  canRequest,
  record,
  ...props
}: RequestProps & { canRequest: boolean; record: ReactNode }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <>
      {canRequest ? (
        <Button type="button" onClick={() => setOpen(true)}>
          {t("Shared.mainnetAccess.requestButton")}
        </Button>
      ) : (
        record
      )}
      {open ? <MainnetAccessRequestModal {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Two steps, then done: the organization's jurisdiction, then the Terms and Conditions read to
 * the end and accepted. Nothing is sent until the last step, so closing early leaves no trace.
 */
function MainnetAccessRequestModal({
  organizationName,
  termsVersion,
  termsUrl,
  onClose,
}: RequestProps & { onClose: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const [step, setStep] = useState<Step>("jurisdiction");
  const jurisdiction = useZodForm(JURISDICTION_SCHEMA, { countryCode: null });
  const terms = useZodForm(TERMS_SCHEMA, { accepted: false });
  const [error, setError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  // The API accepts one version; a reader holding another would show text the admin is not
  // agreeing to, so it links out instead.
  const document = SDP_TERMS_DOCUMENT.version === termsVersion ? SDP_TERMS_DOCUMENT : null;
  const [readToEnd, setReadToEnd] = useState(document === null);

  // A failed submit may still have recorded the request (its email did not go out), so the
  // card behind the dialog is refreshed after any attempt, not only a sent one.
  const attempted = useRef(false);
  const close = () => {
    onClose();
    if (attempted.current) router.refresh();
  };

  const steps = [t("Shared.mainnetAccess.stepJurisdiction"), t("Shared.mainnetAccess.stepTerms")];
  const stepIndex = step === "jurisdiction" ? 0 : 1;

  const continueToTerms = () => {
    if (jurisdiction.validate().ok) setStep("terms");
  };

  const submit = () => {
    const country = jurisdiction.validate();
    if (!country.ok || !terms.validate().ok) return;
    setError(null);
    startSubmit(async () => {
      const result = await requestMainnetAccessAction({
        countryCode: country.data.countryCode,
        termsVersion,
      });
      attempted.current = true;
      if (result.ok) {
        setStep("sent");
      } else {
        setError(result.error);
        router.refresh();
      }
    });
  };

  return (
    <Modal
      isOpen
      onClose={close}
      closeDisabled={submitting}
      size="xl"
      placement="top"
      ariaLabel={t("Shared.mainnetAccess.modalTitle")}
    >
      {step === "sent" ? (
        <SentPanel onDone={close} />
      ) : (
        <div className="flex flex-col gap-5 p-6">
          <div className="space-y-4 pr-8">
            <h2 className="text-lg font-medium text-primary">
              {t("Shared.mainnetAccess.modalTitle")}
            </h2>
            <WizardStepProgress
              currentStep={stepIndex}
              steps={steps}
              progressLabel={t("Shared.mainnetAccess.stepOf", {
                current: stepIndex + 1,
                total: steps.length,
              })}
            />
          </div>

          {step === "jurisdiction" ? (
            <JurisdictionStep
              countryCode={jurisdiction.values.countryCode}
              onChange={(code) => jurisdiction.setField("countryCode", code)}
            />
          ) : (
            <TermsStep
              organizationName={organizationName}
              termsVersion={termsVersion}
              termsUrl={termsUrl}
              document={document}
              readToEnd={readToEnd}
              onReadToEnd={() => setReadToEnd(true)}
              accepted={terms.values.accepted}
              onAcceptedChange={(accepted) => terms.setField("accepted", accepted)}
              disabled={submitting}
            />
          )}

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {t("Shared.mainnetAccess.submitFailed", { error })}
            </p>
          ) : null}

          <RequestFooter
            step={step}
            canContinue={jurisdiction.values.countryCode !== null}
            canSubmit={terms.values.accepted}
            submitting={submitting}
            onCancel={onClose}
            onContinue={continueToTerms}
            onBack={() => setStep("jurisdiction")}
            onSubmit={submit}
          />
        </div>
      )}
    </Modal>
  );
}

function SentPanel({ onDone }: { onDone: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <CheckCircle2Icon aria-hidden className="size-8 text-success" />
      <h2 className="text-lg font-medium text-primary">{t("Shared.mainnetAccess.sentTitle")}</h2>
      <p className="max-w-sm text-sm text-secondary">{t("Shared.mainnetAccess.sentBody")}</p>
      <Button type="button" className="mt-3" onClick={onDone}>
        {t("Shared.mainnetAccess.done")}
      </Button>
    </div>
  );
}

function RequestFooter({
  step,
  canContinue,
  canSubmit,
  submitting,
  onCancel,
  onContinue,
  onBack,
  onSubmit,
}: {
  step: Exclude<Step, "sent">;
  canContinue: boolean;
  canSubmit: boolean;
  submitting: boolean;
  onCancel: () => void;
  onContinue: () => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations();
  if (step === "jurisdiction") {
    return (
      <div className="flex items-center justify-end gap-2 border-t border-border-default pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("Shared.mainnetAccess.cancel")}
        </Button>
        <Button type="button" disabled={!canContinue} onClick={onContinue}>
          {t("Shared.mainnetAccess.continue")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border-default pt-4">
      <Button type="button" variant="secondary" disabled={submitting} onClick={onBack}>
        {t("Shared.mainnetAccess.back")}
      </Button>
      <Button
        type="button"
        disabled={!canSubmit || submitting}
        onClick={onSubmit}
        iconLeft={
          submitting ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : undefined
        }
      >
        {submitting ? t("Shared.mainnetAccess.submitting") : t("Shared.mainnetAccess.submit")}
      </Button>
    </div>
  );
}

function JurisdictionStep({
  countryCode,
  onChange,
}: {
  countryCode: string | null;
  onChange: (code: string) => void;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-primary">
          {t("Shared.mainnetAccess.jurisdictionHeading")}
        </h3>
        <p className="text-sm text-secondary">{t("Shared.mainnetAccess.jurisdictionBody")}</p>
      </div>
      <Combobox
        label={t("Shared.mainnetAccess.countryLabel")}
        value={countryCode}
        onChange={onChange}
        options={COUNTRY_OPTIONS}
        placeholder={t("Shared.mainnetAccess.countryPlaceholder")}
        searchable
        searchPlaceholder={t("Shared.mainnetAccess.countrySearchPlaceholder")}
        required
      />
      <p className="text-xs text-tertiary">{t("Shared.mainnetAccess.jurisdictionFinal")}</p>
    </div>
  );
}

function TermsStep({
  organizationName,
  termsVersion,
  termsUrl,
  document,
  readToEnd,
  onReadToEnd,
  accepted,
  onAcceptedChange,
  disabled,
}: {
  organizationName: string;
  termsVersion: string;
  termsUrl: string;
  document: typeof SDP_TERMS_DOCUMENT | null;
  readToEnd: boolean;
  onReadToEnd: () => void;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  disabled: boolean;
}) {
  const t = useTranslations();
  const checkEnd = useCallback(
    (element: HTMLElement) => {
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - READ_TO_END_SLACK_PX) {
        onReadToEnd();
      }
    },
    [onReadToEnd]
  );
  // A reader whose text fits without scrolling is read as soon as it is shown.
  const readerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) checkEnd(element);
    },
    [checkEnd]
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-primary">
          {t("Shared.mainnetAccess.termsHeading")}
        </h3>
        <p className="text-sm text-secondary">
          {t("Shared.mainnetAccess.termsBody", { organization: organizationName })}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border-default">
        <div className="flex items-center justify-between gap-3 border-b border-border-default bg-fill px-4 py-2.5">
          <span className="text-xs text-tertiary">
            {t("Shared.mainnetAccess.termsVersion", { version: termsVersion })}
          </span>
          <a
            href={termsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-secondary hover:text-primary"
          >
            {t("Shared.mainnetAccess.termsOpen")}
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
        </div>
        {document ? (
          <div
            ref={readerRef}
            onScroll={(event: UIEvent<HTMLDivElement>) => checkEnd(event.currentTarget)}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard to be read.
            tabIndex={0}
            role="document"
            aria-label={document.title}
            className="max-h-[min(22rem,45dvh)] space-y-4 overflow-y-auto bg-surface px-5 py-4 text-sm leading-6 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-strong"
          >
            <div className="space-y-0.5">
              <p className="text-base font-medium text-primary">{document.title}</p>
              <p className="text-xs text-tertiary">{document.effectiveDate}</p>
            </div>
            {document.sections.map((section) => (
              <section key={section.heading} className="space-y-1.5">
                <h4 className="font-medium text-primary">{section.heading}</h4>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="px-5 py-4">
            <Callout variant="info">{t("Shared.mainnetAccess.termsUnavailable")}</Callout>
          </div>
        )}
      </div>

      <label
        className={`flex items-start gap-2.5 text-sm ${readToEnd ? "text-primary" : "text-tertiary"}`}
      >
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0"
          checked={accepted}
          disabled={!readToEnd || disabled}
          onChange={(event) => onAcceptedChange(event.currentTarget.checked)}
        />
        <span>
          {t("Shared.mainnetAccess.termsAccept", { organization: organizationName })}
          {readToEnd ? null : (
            <span className="mt-0.5 block text-xs text-tertiary">
              {t("Shared.mainnetAccess.termsScrollHint")}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}

/** Resends a request whose email did not go out; the API sends the stored request. */
export function MainnetAccessResendButton({
  countryCode,
  termsVersion,
}: {
  countryCode: CountryCode;
  termsVersion: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startResend] = useTransition();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          startResend(async () => {
            setError(null);
            const result = await requestMainnetAccessAction({ countryCode, termsVersion });
            if (result.ok) router.refresh();
            else setError(result.error);
          })
        }
      >
        {pending ? t("Shared.mainnetAccess.resending") : t("Shared.mainnetAccess.resend")}
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {t("Shared.mainnetAccess.submitFailed", { error })}
        </p>
      ) : null}
    </div>
  );
}
