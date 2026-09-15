"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";

/**
 * A write-only secret input.
 *
 * Controlled on purpose: the value has to be clearable by the parent the
 * moment a submission settles, so a failed re-render cannot leave a secret
 * sitting in a mounted input. Nothing here can read a stored secret back — the
 * API's response type carries no field that could return one.
 *
 * The reveal toggle exists because a typo in a masked field is the usual reason
 * a first activation fails, and the value is worth checking before it is sent
 * somewhere it can never be read from again.
 */
export function SecretField({
  name,
  label,
  hint,
  value,
  onChange,
  disabled,
  required = true,
}: {
  name: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const t = useTranslations();
  const fieldId = useId();
  const hintId = useId();
  const [shown, setShown] = useState(false);

  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={fieldId}
          name={name}
          className="flex-1"
          type={shown ? "text" : "password"}
          autoComplete="off"
          required={required}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          aria-pressed={shown}
          // The icon carries no text, so the control needs its own name.
          aria-label={
            shown ? t("DashboardCustody.hideSecret") : t("DashboardCustody.showSecret")
          }
          onClick={() => setShown((current) => !current)}
        >
          {shown ? (
            <EyeOffIcon aria-hidden className="size-4" />
          ) : (
            <EyeIcon aria-hidden className="size-4" />
          )}
        </Button>
      </div>
      {hint ? (
        <p id={hintId} className="text-sm leading-5 text-tertiary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
