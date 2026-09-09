"use client";

import { type ComponentProps, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { TokenValidationMessage } from "./token-validation-message";
import { useInlineValidationMessage } from "./use-inline-validation-message";

export function ActionField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  pattern,
  title,
  min,
  step,
  placeholder,
  inputMode,
  description,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: ComponentProps<typeof Input>["type"];
  required?: boolean;
  pattern?: string;
  title?: string;
  min?: string;
  step?: string;
  placeholder?: string;
  inputMode?: ComponentProps<typeof Input>["inputMode"];
  description?: string;
  error?: string | null;
}) {
  const fieldId = useId();
  const errorId = useId();
  const t = useTranslations();
  const [invalidNumber, setInvalidNumber] = useState(false);
  const { message: nativeError, onInvalid, revalidate } = useInlineValidationMessage(label);
  const fieldError = invalidNumber
    ? t("DashboardIssuance.management.numberRequired")
    : (error ?? nativeError);
  const hasError = Boolean(fieldError);

  return (
    <div className="space-y-2">
      <label
        htmlFor={fieldId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-secondary"
      >
        {label}
        {required ? (
          <span aria-hidden className="text-destructive">
            {" "}
            *
          </span>
        ) : null}
      </label>
      {description ? <p className="text-[13px] leading-5 text-secondary">{description}</p> : null}
      <Input
        id={fieldId}
        type={type === "number" ? "text" : type}
        value={value}
        required={required}
        pattern={type === "number" ? "([0-9]+([.][0-9]*)?|[.][0-9]+)" : pattern}
        title={title}
        min={min}
        step={step}
        placeholder={placeholder}
        inputMode={type === "number" ? "decimal" : inputMode}
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : undefined}
        onInvalid={onInvalid}
        onChange={(event) => {
          if (type === "number" && !/^\d*\.?\d*$/.test(event.currentTarget.value)) {
            event.currentTarget.value = value;
            event.currentTarget.setCustomValidity(t("DashboardIssuance.management.numberRequired"));
            setInvalidNumber(true);
            return;
          }
          event.currentTarget.setCustomValidity("");
          setInvalidNumber(false);
          onChange(event.currentTarget.value);
          revalidate(event.currentTarget);
        }}
        className="h-11 rounded-[12px] border-border-default bg-surface-raised px-4 shadow-none"
      />
      <TokenValidationMessage id={errorId} message={fieldError} />
    </div>
  );
}
