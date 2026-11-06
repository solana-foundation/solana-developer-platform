"use client";

import type { ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { cn } from "@sdp/ui/cn";
import { InfoHint } from "@sdp/ui/info-hint";
import { Select, SelectItem } from "@sdp/ui/select";
import type { ReactNode } from "react";
import { formatCustodyProviderName } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { formatDateTime } from "@/lib/date-format";
import {
  API_KEY_EXPIRY_DAYS,
  type ApiKeyExpiryChoice,
  resolveExpiryChoice,
} from "./api-key-presentation";

/** A form field's 13px label with an optional (i), 8px over its control. */
export function ApiKeyField({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={htmlFor}
        className="flex items-center gap-1.5 text-meta font-medium text-primary"
      >
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </label>
      {children}
    </div>
  );
}

/** The visible radio or checkbox: a ring, filled to a thick ink ring (or a tick box) when on. */
function ChoiceMark({ checked, control }: { checked: boolean; control: "radio" | "checkbox" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center border border-border-strong transition-[border-width] motion-reduce:transition-none",
        control === "radio" ? "rounded-full" : "rounded-sm",
        checked &&
          (control === "radio" ? "border-[0.3125rem] border-primary" : "border-primary bg-primary"),
        "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary"
      )}
    >
      {checked && control === "checkbox" ? (
        <svg viewBox="0 0 12 12" className="size-3 text-on-primary" fill="none" aria-hidden>
          <path d="M2.5 6.2 5 8.5l4.5-5" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      ) : null}
    </span>
  );
}

function walletName(wallet: PaymentsDashboardWallet): string {
  return wallet.label?.trim() || wallet.walletId;
}

function WalletCheckRow({
  wallet,
  checked,
  onToggle,
}: {
  wallet: PaymentsDashboardWallet;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations();
  const name = walletName(wallet);
  return (
    <label className="flex cursor-pointer items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={onToggle}
        aria-label={t("DashboardCustody.apiKeySelectWallet", { wallet: name })}
      />
      <ChoiceMark checked={checked} control="checkbox" />
      {wallet.provider ? <WalletProviderMark provider={wallet.provider} size="row" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-field text-primary">{name}</span>
        {wallet.provider ? (
          <span className="block truncate text-meta text-secondary">
            {formatCustodyProviderName(wallet.provider)}
          </span>
        ) : null}
      </span>
      {wallet.isRuntimeExecutionAllowed ? null : (
        <span className="flex shrink-0 items-center gap-1.5 text-meta text-warning">
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {t("DashboardCustody.apiKeyPage.walletCannotSign")}
        </span>
      )}
    </label>
  );
}

/**
 * Every wallet in the project, or the ones ticked. "N of M can sign" counts the wallets SDP can
 * sign with now; a wallet that cannot is still listed, so the key keeps it once signing returns.
 */
export function ApiKeyWalletPicker({
  wallets,
  walletScope,
  walletIds,
  showRequired,
  onChange,
}: {
  wallets: PaymentsDashboardWallet[];
  walletScope: ApiKeyWalletScope;
  walletIds: readonly string[];
  showRequired: boolean;
  onChange: (walletScope: ApiKeyWalletScope, walletIds: string[]) => void;
}) {
  const t = useTranslations();
  const signable = wallets.filter((wallet) => wallet.isRuntimeExecutionAllowed).length;
  const selectedWalletIds = new Set(walletIds);
  const scopes: { scope: ApiKeyWalletScope; title: string; trailing?: string }[] = [
    {
      scope: "all",
      title: t("DashboardCustody.apiKeyPage.allWalletsInProject"),
      trailing: t("DashboardCustody.apiKeyPage.walletsCanSign", {
        count: signable,
        total: wallets.length,
      }),
    },
    { scope: "selected", title: t("DashboardCustody.selectedWallets") },
  ];
  const toggle = (walletId: string) =>
    onChange(
      "selected",
      walletIds.includes(walletId)
        ? walletIds.filter((id) => id !== walletId)
        : [...walletIds, walletId]
    );

  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-label={t("DashboardCustody.wallets")}
        className="overflow-hidden rounded-card border border-border-default bg-surface-tile"
      >
        {scopes.map(({ scope, title, trailing }, index) => (
          <label
            key={scope}
            className={cn(
              "flex cursor-pointer items-center gap-3 px-4 py-3",
              index > 0 && "border-t border-border-subtle",
              walletScope === scope && "bg-fill-subtle"
            )}
          >
            <input
              type="radio"
              name="api-key-wallet-scope"
              className="peer sr-only"
              checked={walletScope === scope}
              onChange={() => onChange(scope, [...walletIds])}
            />
            <ChoiceMark checked={walletScope === scope} control="radio" />
            <span className="min-w-0 flex-1 text-field text-primary">{title}</span>
            {trailing ? (
              <span className="shrink-0 text-meta text-secondary">{trailing}</span>
            ) : null}
          </label>
        ))}
      </div>
      {walletScope === "selected" ? (
        wallets.length > 0 ? (
          <div className="max-h-96 overflow-y-auto rounded-card border border-border-default bg-surface-tile">
            {wallets.map((wallet) => (
              <WalletCheckRow
                key={wallet.id}
                wallet={wallet}
                checked={selectedWalletIds.has(wallet.id)}
                onToggle={() => toggle(wallet.id)}
              />
            ))}
          </div>
        ) : (
          <p className="text-body text-tertiary">{t("DashboardCustody.apiKeyPage.noWallets")}</p>
        )
      ) : null}
      {showRequired && walletScope === "selected" && walletIds.length === 0 ? (
        <p className="text-meta text-error">{t("DashboardCustody.apiKeyWalletRequired")}</p>
      ) : null}
    </div>
  );
}

function expiryChoiceValue(choice: ApiKeyExpiryChoice): string {
  return choice === null ? "never" : String(choice);
}

function parseExpiryChoice(value: string | null): ApiKeyExpiryChoice {
  if (value === "keep") return "keep";
  if (value === "never") return null;
  return API_KEY_EXPIRY_DAYS.find((days) => days !== null && String(days) === value) ?? null;
}

/**
 * The expiry as the design picks it: a few lifetimes, with when the key would stop working
 * beside them. An edited key also offers to keep its current expiry.
 */
export function ApiKeyExpiryField({
  id,
  choice,
  current,
  now,
  onChange,
}: {
  id: string;
  choice: ApiKeyExpiryChoice;
  /** The edited key's expiry; undefined while creating. */
  current?: string | null;
  now: number;
  onChange: (choice: ApiKeyExpiryChoice) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const resolved = resolveExpiryChoice(choice, current ?? null, now);
  const options: ApiKeyExpiryChoice[] =
    current === undefined ? [...API_KEY_EXPIRY_DAYS] : ["keep", ...API_KEY_EXPIRY_DAYS];

  const optionLabel = (option: ApiKeyExpiryChoice): string => {
    if (option === "keep") {
      return current
        ? t("DashboardCustody.apiKeyPage.expiryKeep", {
            date: formatDateTime(locale, timeZone, current) ?? current,
          })
        : t("DashboardCustody.apiKeyPage.expiryKeepNever");
    }
    if (option === null) return t("DashboardCustody.apiKeyPage.noExpiry");
    return option === 365
      ? t("DashboardCustody.apiKeyPage.expiryInYear")
      : t("DashboardCustody.apiKeyPage.expiryInDays", { count: option });
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <Select
        id={id}
        value={expiryChoiceValue(choice)}
        onValueChange={(value) => onChange(parseExpiryChoice(value))}
        className="sm:w-56"
      >
        {options.map((option) => (
          <SelectItem key={expiryChoiceValue(option)} value={expiryChoiceValue(option)}>
            {optionLabel(option)}
          </SelectItem>
        ))}
      </Select>
      <span className="text-body text-secondary">
        {resolved
          ? t("DashboardCustody.apiKeyPage.stopsWorkingOn", {
              date: formatDateTime(locale, timeZone, resolved) ?? resolved,
            })
          : t("DashboardCustody.apiKeyPage.neverStops")}
      </span>
    </div>
  );
}
