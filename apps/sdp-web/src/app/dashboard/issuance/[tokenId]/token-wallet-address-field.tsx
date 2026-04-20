"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
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
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]"
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
          placeholder={placeholder ?? "Choose a wallet or paste a Solana address"}
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
          className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white pr-20 shadow-none"
        />
        {value.trim() ? (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onChange("");
              setIsOpen(false);
            }}
            className="absolute top-1/2 right-11 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[8px] text-[rgba(28,28,29,0.5)] transition-colors hover:bg-[rgba(28,28,29,0.06)] hover:text-[#1c1c1d]"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
        {availableWallets.length > 0 ? (
          <button
            type="button"
            aria-label="Select an existing wallet"
            onClick={() => setIsOpen((current) => !current)}
            className="absolute top-1/2 right-3 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[8px] text-[rgba(28,28,29,0.62)] transition-colors hover:bg-[rgba(28,28,29,0.06)] hover:text-[#1c1c1d]"
          >
            <ChevronDown
              className={["h-4 w-4 transition-transform", isOpen ? "rotate-180" : ""].join(" ")}
            />
          </button>
        ) : null}
        {visibleWallets.length > 0 ? (
          <div className="absolute z-20 mt-2 max-h-64 w-full overflow-auto rounded-[14px] border border-[rgba(28,28,29,0.12)] bg-white py-2 shadow-[0_16px_40px_rgba(28,28,29,0.12)]">
            {visibleWallets.map((wallet) => (
              <button
                key={wallet.id}
                type="button"
                onClick={() => {
                  onChange(wallet.publicKey);
                  setIsOpen(false);
                }}
                className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-[rgba(28,28,29,0.04)]"
              >
                <span className="text-sm font-medium text-[#1c1c1d]">
                  {wallet.label?.trim() || wallet.walletId}
                </span>
                <span className="font-mono text-xs text-[rgba(28,28,29,0.62)]">
                  {wallet.publicKey}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {availableWallets.length > 0 ? (
        <p className="text-sm text-[rgba(28,28,29,0.64)]">
          Type to filter existing wallets, use the dropdown, or paste any Solana address.
        </p>
      ) : null}
      <TokenValidationMessage message={error ?? null} />
    </div>
  );
}
