"use client";

import { COUNTRIES, COUNTRY_CODES } from "@sdp/types/countries";
import {
  foundationContactEmailSchema,
  MAINNET_USE_CASE_MAX_LENGTH,
  SDP_TERMS,
} from "@sdp/types/mainnet-access";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import { SDP_TERMS_PATH } from "@sdp/types/site";
import { Button } from "@sdp/ui/button";
import { Combobox, type ComboboxOption } from "@sdp/ui/combobox";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { Textarea } from "@sdp/ui/textarea";
import { WizardStepProgress } from "@sdp/ui/wizard-step-progress";
import { CheckCircle2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  type UIEvent,
  useCallback,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { z } from "zod";
import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { SdpTermsContent } from "@/components/sdp-terms-content";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { refreshKeepingDashboardUrl } from "@/lib/dashboard-url-state";
import { useZodForm } from "@/lib/use-zod-form";
import { notifyMainnetAccess, requestMainnetAccess } from "./mainnet-access";

const COUNTRY_OPTIONS: readonly ComboboxOption[] = COUNTRIES.map((country) => {
  const flag = regionFlagEmoji(country.code);
  return { value: country.code, label: flag ? `${flag} ${country.name}` : country.name };
});

/** How close to the end of the reader counts as read, so sub-pixel rounding never blocks it. */
const READ_TO_END_SLACK_PX = 8;

type Step = "jurisdiction" | "about" | "terms" | "sent";
const FORM_STEPS = ["jurisdiction", "about", "terms"] as const satisfies readonly Step[];

const CONTACT_ANSWERS = ["no", "yes"] as const;
type ContactAnswer = (typeof CONTACT_ANSWERS)[number];
const CONTACT_EMAIL_INVALID = "Shared.mainnetAccess.contactEmailInvalid" satisfies MessageKey;

/** Step 1: the picker answers with any string, so the form parses it into a known country. */
const JURISDICTION_SCHEMA = z.object({
  countryCode: z.string().nullable().pipe(z.enum(COUNTRY_CODES)),
});
/**
 * Step 2 (PRO-2481): whether someone at the Solana Foundation knows the organization, and who, and
 * an optional line on what it builds. "No" is an answer, so the step always says one or the other.
 */
const ABOUT_SCHEMA = z
  .object({
    hasContact: z.enum(CONTACT_ANSWERS).nullable().pipe(z.enum(CONTACT_ANSWERS)),
    contactEmail: z.string(),
    useCase: z.string(),
  })
  .transform((values, ctx) => {
    let foundationContactEmail: string | null = null;
    if (values.hasContact === "yes") {
      const contact = foundationContactEmailSchema.safeParse(values.contactEmail);
      if (!contact.success) {
        ctx.addIssue({ code: "custom", path: ["contactEmail"], message: CONTACT_EMAIL_INVALID });
        return z.NEVER;
      }
      foundationContactEmail = contact.data;
    }
    const useCase = values.useCase.trim().slice(0, MAINNET_USE_CASE_MAX_LENGTH);
    return { foundationContactEmail, useCase: useCase === "" ? null : useCase };
  });
/** Step 3: the admin accepts the terms on the organization's behalf. */
const TERMS_SCHEMA = z.object({ accepted: z.boolean().refine((accepted) => accepted) });

interface RequestProps {
  organizationId: string;
  organizationName: string;
}

/**
 * The Mainnet section: the organization's mainnet record (`record`), with the one-time request
 * at the heading while it has none. It owns the dialog and stays mounted when the page refreshes
 * to the sent request, so the dialog's confirmation outlives that refresh.
 */
export function MainnetAccessRequestHost({
  canRequest,
  record,
  ...props
}: RequestProps & { canRequest: boolean; record: ReactNode }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <RecordSection
      id="mainnet-access"
      title={t("Shared.mainnetAccess.title")}
      aside={
        canRequest ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t("Shared.mainnetAccess.requestButton")}
          </Button>
        ) : null
      }
    >
      {record}
      {open ? <MainnetAccessRequestModal {...props} onClose={() => setOpen(false)} /> : null}
    </RecordSection>
  );
}

/**
 * Three steps, then done: the organization's jurisdiction, its Solana Foundation contact and what
 * it builds, then the Terms and Conditions read to the end and accepted. Nothing is sent until the
 * last step, so closing early leaves no trace.
 */
function MainnetAccessRequestModal({
  organizationId,
  organizationName,
  onClose,
}: RequestProps & { onClose: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const [step, setStep] = useState<Step>("jurisdiction");
  const jurisdiction = useZodForm(JURISDICTION_SCHEMA, { countryCode: null });
  const about = useZodForm(
    ABOUT_SCHEMA,
    { hasContact: null, contactEmail: "", useCase: "" },
    (message) => (message === CONTACT_EMAIL_INVALID ? t(CONTACT_EMAIL_INVALID) : message)
  );
  const terms = useZodForm(TERMS_SCHEMA, { accepted: false });
  const [error, setError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const [readToEnd, setReadToEnd] = useState(false);

  // A failed submit may still have recorded the request (its email did not go out), so the
  // card behind the dialog is refreshed after any attempt, not only a sent one.
  const attempted = useRef(false);
  const close = () => {
    onClose();
    if (attempted.current) refreshKeepingDashboardUrl(router);
  };

  const steps = [
    t("Shared.mainnetAccess.stepJurisdiction"),
    t("Shared.mainnetAccess.stepAbout"),
    t("Shared.mainnetAccess.stepTerms"),
  ];
  const stepIndex = step === "sent" ? FORM_STEPS.length - 1 : FORM_STEPS.indexOf(step);

  const continueFrom = () => {
    if (step === "jurisdiction" && jurisdiction.validate().ok) setStep("about");
    else if (step === "about" && about.validate().ok) setStep("terms");
  };
  const back = () => setStep(step === "terms" ? "about" : "jurisdiction");

  const submit = () => {
    const country = jurisdiction.validate();
    const answers = about.validate();
    if (!country.ok || !answers.ok || !terms.validate().ok) return;
    setError(null);
    startSubmit(async () => {
      const result = await requestMainnetAccess(organizationId, {
        countryCode: country.data.countryCode,
        termsVersion: SDP_TERMS.version,
        foundationContactEmail: answers.data.foundationContactEmail,
        useCase: answers.data.useCase,
      });
      attempted.current = true;
      if (result.ok) {
        setStep("sent");
      } else {
        setError(result.error);
      }
      refreshKeepingDashboardUrl(router);
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
          ) : step === "about" ? (
            <AboutStep
              hasContact={about.values.hasContact}
              onHasContactChange={(answer) => about.setField("hasContact", answer)}
              contactEmail={about.values.contactEmail}
              onContactEmailChange={(email) => about.setField("contactEmail", email)}
              contactEmailError={about.errors.contactEmail}
              useCase={about.values.useCase}
              onUseCaseChange={(useCase) => about.setField("useCase", useCase)}
            />
          ) : (
            <TermsStep
              organizationName={organizationName}
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
            canContinue={
              step === "jurisdiction"
                ? jurisdiction.values.countryCode !== null
                : about.values.hasContact !== null
            }
            canSubmit={terms.values.accepted}
            submitting={submitting}
            onCancel={onClose}
            onContinue={continueFrom}
            onBack={back}
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
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border-default pt-4">
      {step === "jurisdiction" ? (
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("Shared.mainnetAccess.cancel")}
        </Button>
      ) : (
        <Button type="button" variant="secondary" disabled={submitting} onClick={onBack}>
          {t("Shared.mainnetAccess.back")}
        </Button>
      )}
      {step === "terms" ? (
        <Button type="button" disabled={!canSubmit} loading={submitting} onClick={onSubmit}>
          {t("Shared.mainnetAccess.submit")}
        </Button>
      ) : (
        <Button type="button" disabled={!canContinue} onClick={onContinue}>
          {t("Shared.mainnetAccess.continue")}
        </Button>
      )}
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

const CONTACT_OPTION_KEYS = {
  no: { label: "Shared.mainnetAccess.contactNo", help: "Shared.mainnetAccess.contactNoHelp" },
  yes: { label: "Shared.mainnetAccess.contactYes", help: "Shared.mainnetAccess.contactYesHelp" },
} as const satisfies Record<ContactAnswer, { label: MessageKey; help: MessageKey }>;

/**
 * Who at the Solana Foundation knows the organization, if anyone, and what it builds. Both go to
 * the reviewer with the request; the API takes a contact only at the Foundation's domain.
 */
function AboutStep({
  hasContact,
  onHasContactChange,
  contactEmail,
  onContactEmailChange,
  contactEmailError,
  useCase,
  onUseCaseChange,
}: {
  hasContact: ContactAnswer | null;
  onHasContactChange: (answer: ContactAnswer) => void;
  contactEmail: string;
  onContactEmailChange: (email: string) => void;
  contactEmailError: string | undefined;
  useCase: string;
  onUseCaseChange: (useCase: string) => void;
}) {
  const t = useTranslations();
  const ids = useId();
  const contactEmailId = `${ids}-contact-email`;
  const useCaseId = `${ids}-use-case`;
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-primary">
          {t("Shared.mainnetAccess.aboutHeading")}
        </h3>
        <p className="text-sm text-secondary">{t("Shared.mainnetAccess.aboutBody")}</p>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium text-primary">
          {t("Shared.mainnetAccess.contactLegend")}
        </legend>
        {CONTACT_ANSWERS.map((answer) => (
          <label
            key={answer}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border-default p-3"
          >
            <input
              type="radio"
              name={`${ids}-contact`}
              value={answer}
              checked={hasContact === answer}
              onChange={() => onHasContactChange(answer)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-primary">
                {t(CONTACT_OPTION_KEYS[answer].label)}
              </span>
              <span className="mt-1 block text-xs text-secondary">
                {t(CONTACT_OPTION_KEYS[answer].help)}
              </span>
            </span>
          </label>
        ))}
        {hasContact === "yes" ? (
          <div className="grid gap-2 pt-1">
            <Label htmlFor={contactEmailId}>{t("Shared.mainnetAccess.contactEmailLabel")}</Label>
            <Input
              id={contactEmailId}
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={contactEmail}
              onChange={(event) => onContactEmailChange(event.currentTarget.value)}
              placeholder={t("Shared.mainnetAccess.contactEmailPlaceholder")}
              error={contactEmailError}
            />
          </div>
        ) : null}
      </fieldset>

      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={useCaseId}>
            {t("Shared.mainnetAccess.useCaseLabel")}{" "}
            <span className="font-normal text-tertiary">
              {t("Shared.mainnetAccess.useCaseOptional")}
            </span>
          </Label>
          <span className="text-xs text-tertiary" aria-live="polite">
            {t("Shared.mainnetAccess.useCaseCount", {
              length: String(useCase.length),
              max: String(MAINNET_USE_CASE_MAX_LENGTH),
            })}
          </span>
        </div>
        <Textarea
          id={useCaseId}
          rows={3}
          maxLength={MAINNET_USE_CASE_MAX_LENGTH}
          value={useCase}
          onChange={(event) => onUseCaseChange(event.currentTarget.value)}
          placeholder={t("Shared.mainnetAccess.useCasePlaceholder")}
          className="resize-none"
        />
      </div>
    </div>
  );
}

/**
 * The terms the API records with the request, `SDP_TERMS`: the admin accepts the version of the
 * text shown here, and the API refuses any version but its own.
 */
function TermsStep({
  organizationName,
  readToEnd,
  onReadToEnd,
  accepted,
  onAcceptedChange,
  disabled,
}: {
  organizationName: string;
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
        <div className="flex items-center justify-between gap-3 border-b border-border-default bg-fill px-4 py-2.5 text-xs text-tertiary">
          <span>{t("Shared.mainnetAccess.termsVersion", { version: SDP_TERMS.version })}</span>
          <a
            href={SDP_TERMS_PATH}
            target="_blank"
            rel="noreferrer"
            className="text-secondary underline-offset-2 hover:text-primary hover:underline"
          >
            {t("Shared.mainnetAccess.termsOpenPage")}
          </a>
        </div>
        <div
          ref={readerRef}
          onScroll={(event: UIEvent<HTMLDivElement>) => checkEnd(event.currentTarget)}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard to be read.
          tabIndex={0}
          role="document"
          aria-label={SDP_TERMS.title}
          className="max-h-[min(22rem,45dvh)] space-y-4 overflow-y-auto bg-surface px-5 py-4 text-sm leading-6 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-strong"
        >
          <div className="space-y-0.5">
            <p className="text-base font-medium text-primary">{SDP_TERMS.title}</p>
            <p className="text-xs text-tertiary">{SDP_TERMS.effectiveDate}</p>
          </div>
          <SdpTermsContent headings={{ section: "h4", subsection: "h5" }} className="space-y-6" />
        </div>
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

/** Sends a recorded request whose email did not go out. */
export function MainnetAccessResendButton({ organizationId }: { organizationId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startResend] = useTransition();
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={pending}
        onClick={() =>
          startResend(async () => {
            setError(null);
            const result = await notifyMainnetAccess(organizationId);
            if (result.ok) refreshKeepingDashboardUrl(router);
            else setError(result.error);
          })
        }
      >
        {t("Shared.mainnetAccess.resend")}
      </Button>
      {error ? (
        <p className="text-meta text-error" role="alert">
          {t("Shared.mainnetAccess.submitFailed", { error })}
        </p>
      ) : null}
    </div>
  );
}
