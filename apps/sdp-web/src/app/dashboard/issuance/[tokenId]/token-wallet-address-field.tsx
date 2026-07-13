"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { TokenValidationMessage } from "./token-validation-message";

interface TokenWalletAddressFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  walletOptions?: PaymentsDashboardWallet[];
  required?: boolean;
  pattern?: string;
  title?: string;
  placeholder?: string;
  error?: string | null;
}

export function TokenWalletAddressField({
  label,
  value,
  onChange,
  walletOptions = [],
  required = false,
  pattern,
  title,
  placeholder,
  error,
}: TokenWalletAddressFieldProps) {
  const t = useTranslations();
  const inputId = useId();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const availableWallets = walletOptions.filter((wallet) => wallet.publicKey.trim());
  const normalizedValue = value.trim().toLowerCase();
  const filteredWallets = useMemo(() => {
    if (!normalizedValue) {
      return availableWallets;
    }

    return availableWallets.filter((wallet) => {
      const label = wallet.label?.trim().toLowerCase() ?? "";
      return (
        label.includes(normalizedValue) || wallet.publicKey.toLowerCase().includes(normalizedValue)
      );
    });
  }, [availableWallets, normalizedValue]);
  const visibleWallets = isOpen ? filteredWallets : [];

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  return (
    <div className="space-y-2">
      <label
        htmlFor={inputId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-secondary"
      >
        {label}
      </label>
      <div ref={wrapperRef} className="relative">
        <Input
          id={inputId}
          type="text"
          value={value}
          required={required}
          pattern={pattern}
          title={title}
          placeholder={placeholder ?? t("DashboardIssuance.wallet.chooseOrPaste")}
          autoComplete="off"
          aria-invalid={Boolean(error)}
          onFocus={() => {
            if (availableWallets.length > 0) {
              setIsOpen(true);
            }
          }}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            if (availableWallets.length > 0) {
              setIsOpen(true);
            }
          }}
          className="h-11 rounded-[12px] border-border-default bg-white pr-20 shadow-none"
        />
        {value.trim() ? (
          <button
            type="button"
            aria-label={t("DashboardIssuance.wallet.clear", { label: label.toLowerCase() })}
            onClick={() => {
              onChange("");
              setIsOpen(false);
            }}
            className="absolute top-1/2 right-11 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[8px] text-tertiary transition-colors hover:bg-fill hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
        {availableWallets.length > 0 ? (
          <button
            type="button"
            aria-label={t("DashboardIssuance.wallet.selectExisting")}
            onClick={() => setIsOpen((current) => !current)}
            className="absolute top-1/2 right-3 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[8px] text-secondary transition-colors hover:bg-fill hover:text-primary"
          >
            <ChevronDown
              className={["h-4 w-4 transition-transform", isOpen ? "rotate-180" : ""].join(" ")}
            />
          </button>
        ) : null}
        {visibleWallets.length > 0 ? (
          <div className="absolute z-20 mt-2 max-h-64 w-full overflow-auto rounded-[14px] border border-border-default bg-white py-2 shadow-[0_16px_40px_rgba(28,28,29,0.12)]">
            {visibleWallets.map((wallet) => (
              <button
                key={wallet.id}
                type="button"
                onClick={() => {
                  onChange(wallet.publicKey);
                  setIsOpen(false);
                }}
                className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-fill-subtle"
              >
                <span className="text-sm font-medium text-primary">
                  {wallet.label?.trim() || wallet.walletId}
                </span>
                <span className="font-mono text-xs text-secondary">{wallet.publicKey}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {availableWallets.length > 0 ? (
        <p className="text-sm text-secondary">{t("DashboardIssuance.wallet.filterHint")}</p>
      ) : null}
      <TokenValidationMessage message={error ?? null} />
    </div>
  );
}
