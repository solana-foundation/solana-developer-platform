"use client";

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { CheckIcon, ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { openBvnkCustomerLink } from "@/lib/trusted-ramp-destinations";

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
 * Renders BVNK's agreement consent as a checklist: one row per required
 * agreement with an animated checkbox and inline agreement/privacy-policy
 * links. Consent is recorded per agreement in the requirements hook; the
 * wizard's primary action submits once every agreement is checked.
 *
 * @param props - Pending agreements, the names already accepted, the toggle
 *   callback, and whether the checkboxes are disabled (advance in flight).
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
  onToggle: (name: string, accepted: boolean) => void;
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
      <ul className="flex w-full max-w-md flex-col gap-3">
        {agreements.map((agreement) => {
          const accepted = acceptedAgreements.includes(agreement.name);
          return (
            <li key={agreement.name}>
              <label className="group flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--input-border-idle)] bg-[var(--input-bg-idle)] px-4 py-3 text-left transition-colors duration-150 has-checked:border-[var(--input-border-focus)] has-disabled:cursor-default motion-reduce:transition-none">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={accepted}
                  disabled={disabled}
                  onChange={(event) => onToggle(agreement.name, event.currentTarget.checked)}
                />
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-[var(--input-border-idle)] transition-colors duration-150 peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:shadow-[0_0_0_2px_var(--input-focus-ring)]"
                >
                  <CheckIcon className="size-3.5 scale-50 text-on-primary opacity-0 transition duration-150 ease-out motion-reduce:transition-none group-has-checked:scale-100 group-has-checked:opacity-100" />
                </span>
                <span className="text-sm leading-relaxed text-tertiary transition-colors duration-150 group-has-checked:text-primary">
                  {t("DashboardPayments.bvnk.agreementConsentPrefix")}{" "}
                  <AgreementLink url={agreement.url}>{agreement.displayName}</AgreementLink>{" "}
                  {t("DashboardPayments.bvnk.agreementConsentJoin")}{" "}
                  <AgreementLink url={agreement.privacyPolicyUrl}>
                    {t("DashboardPayments.bvnk.privacyPolicy")}
                  </AgreementLink>
                  .
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
