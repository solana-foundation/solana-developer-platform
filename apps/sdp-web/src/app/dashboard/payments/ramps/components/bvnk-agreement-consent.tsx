"use client";

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { CheckIcon, ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { openBvnkCustomerLink } from "@/lib/trusted-ramp-destinations";
import { bvnkAgreementConsentKeys } from "../hooks/use-counterparty-requirements";

type PendingAgreements = Extract<
  CounterpartyRequirements,
  { status: "counterparty_collect_agreement" }
>["agreements"];

/**
 * Renders one inline agreement/privacy-policy link inside a checklist row.
 * A button's click is interactive-content activation, so the surrounding
 * label's synthetic click on the checkbox is skipped by spec (HTML label
 * activation does nothing for interactive descendants).
 *
 * @param props - The provider URL to open and the link text.
 * @returns The link button.
 */
function AgreementLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="underline underline-offset-2 text-primary hover:opacity-80"
      onClick={() => openBvnkCustomerLink(url)}
    >
      {children}
    </button>
  );
}

/**
 * One consent row: a visually hidden native checkbox, its animated box, and
 * the consent sentence.
 *
 * @param props - Checked state, disabled flag, change handler, and the sentence.
 * @returns The row.
 */
function ConsentRow({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (accepted: boolean) => void;
  children: ReactNode;
}) {
  return (
    <li>
      <label className="group flex cursor-pointer items-start gap-3 py-1.5 text-left has-disabled:cursor-default">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-[var(--input-border-idle)] transition-colors duration-150 peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:shadow-[0_0_0_2px_var(--input-focus-ring)] motion-reduce:transition-none"
        >
          <CheckIcon className="size-3.5 scale-50 text-on-primary opacity-0 transition duration-150 ease-out motion-reduce:transition-none group-has-checked:scale-100 group-has-checked:opacity-100" />
        </span>
        <span className="text-sm leading-relaxed text-tertiary transition-colors duration-150 group-has-checked:text-primary">
          {children}
        </span>
      </label>
    </li>
  );
}

/**
 * Renders BVNK's agreement consent as a checklist: two rows per required
 * agreement, one for the agreement text and one for its privacy policy, each
 * with an animated checkbox and an inline link. Consent is recorded per key in
 * the requirements hook; the wizard's primary action submits once every row
 * is checked.
 *
 * @param props - Pending agreements, the consent keys already accepted, the
 *   toggle callback, and whether the checkboxes are disabled (advance in flight).
 * @returns The consent checklist.
 */
export function BvnkAgreementConsent({
  agreements,
  acceptedAgreements,
  onToggle,
  disabled,
}: {
  agreements: PendingAgreements;
  acceptedAgreements: readonly string[];
  onToggle: (key: string, accepted: boolean) => void;
  disabled: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <ShieldCheckIcon className="size-10 text-primary" />
      <p className="text-lg font-medium text-primary">
        {t("DashboardPayments.bvnk.agreementRequiredTitle")}
      </p>
      <p className="max-w-md text-sm leading-relaxed text-tertiary">
        {t("DashboardPayments.bvnk.agreementRequiredDescription")}
      </p>
      <ul className="flex w-full max-w-md flex-col">
        {agreements.flatMap((agreement) => {
          const keys = bvnkAgreementConsentKeys(agreement);
          return [
            <ConsentRow
              key={keys.agreement}
              checked={acceptedAgreements.includes(keys.agreement)}
              disabled={disabled}
              onChange={(accepted) => onToggle(keys.agreement, accepted)}
            >
              {t("DashboardPayments.bvnk.agreementConsentPrefix")}{" "}
              <AgreementLink url={agreement.url}>{agreement.displayName}</AgreementLink>.
            </ConsentRow>,
            <ConsentRow
              key={keys.privacyPolicy}
              checked={acceptedAgreements.includes(keys.privacyPolicy)}
              disabled={disabled}
              onChange={(accepted) => onToggle(keys.privacyPolicy, accepted)}
            >
              {t("DashboardPayments.bvnk.agreementConsentPrefix")}{" "}
              <AgreementLink url={agreement.privacyPolicyUrl}>
                {t("DashboardPayments.bvnk.privacyPolicy")}
              </AgreementLink>
              .
            </ConsentRow>,
          ];
        })}
      </ul>
    </div>
  );
}
