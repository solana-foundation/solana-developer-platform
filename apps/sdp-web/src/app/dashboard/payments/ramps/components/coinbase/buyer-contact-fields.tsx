"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { buyerEmailError, buyerPhoneError } from "../../schema";

type BuyerContactFieldsProps = {
  email: string;
  phone: string;
  onEmailChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
};

/**
 * Coinbase alone needs the buyer's contact details to create an order, so these
 * render on the deposit step only when Coinbase is the selected provider. They
 * are sent with the quote and never stored: the API strips them from the policy
 * record, and a Coinbase quote that would need approval is refused outright.
 */
export function BuyerContactFields({
  email,
  phone,
  onEmailChange,
  onPhoneChange,
}: BuyerContactFieldsProps) {
  const t = useTranslations();
  // Only complain about what the user has actually typed. An untouched field
  // leaves Next disabled, which is the same signal every other step gives.
  const emailIssue = email.trim().length > 0 ? buyerEmailError(email) : null;
  const phoneIssue = phone.trim().length > 0 ? buyerPhoneError(phone) : null;

  return (
    <div className="space-y-4 rounded-2xl border border-border-default bg-fill-subtle px-4 py-4">
      <p className="text-sm text-tertiary">{t("DashboardPayments.ramps.buyerContactHint")}</p>
      <div className="space-y-2">
        <Label htmlFor="coinbase-buyer-email">{t("DashboardPayments.ramps.buyerEmailLabel")}</Label>
        <Input
          size="xl"
          id="coinbase-buyer-email"
          type="email"
          autoComplete="email"
          placeholder={t("DashboardPayments.ramps.buyerEmailPlaceholder")}
          value={email}
          aria-invalid={emailIssue !== null}
          aria-describedby={emailIssue === null ? undefined : "coinbase-buyer-email-error"}
          onChange={(event) => onEmailChange(event.target.value)}
        />
        {emailIssue === null ? null : (
          <p id="coinbase-buyer-email-error" role="alert" className="text-sm text-error">
            {emailIssue}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="coinbase-buyer-phone">{t("DashboardPayments.ramps.buyerPhoneLabel")}</Label>
        <Input
          size="xl"
          id="coinbase-buyer-phone"
          type="tel"
          autoComplete="tel"
          placeholder={t("DashboardPayments.ramps.buyerPhonePlaceholder")}
          value={phone}
          aria-invalid={phoneIssue !== null}
          aria-describedby={phoneIssue === null ? undefined : "coinbase-buyer-phone-error"}
          onChange={(event) => onPhoneChange(event.target.value)}
        />
        {phoneIssue === null ? null : (
          <p id="coinbase-buyer-phone-error" role="alert" className="text-sm text-error">
            {phoneIssue}
          </p>
        )}
      </div>
    </div>
  );
}
