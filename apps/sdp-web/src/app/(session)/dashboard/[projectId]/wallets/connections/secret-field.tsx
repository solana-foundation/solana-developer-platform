"use client";

import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Textarea } from "@sdp/ui/textarea";
import { useId, useState } from "react";
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
  multiline = false,
}: {
  name: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  multiline?: boolean;
}) {
  const t = useTranslations();
  const fieldId = useId();
  const hintId = useId();
  const [shown, setShown] = useState(false);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex items-center gap-2">
        {multiline ? (
          <Textarea
            id={fieldId}
            name={name}
            className={
              shown
                ? "min-h-32 min-w-0 flex-1"
                : "min-h-32 min-w-0 flex-1 [-webkit-text-security:disc]"
            }
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required={required}
            disabled={disabled}
            aria-describedby={hint ? hintId : undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <Input
            size="xl"
            id={fieldId}
            name={name}
            className="flex-1 font-mono"
            type={shown ? "text" : "password"}
            autoComplete="off"
            required={required}
            disabled={disabled}
            aria-describedby={hint ? hintId : undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-pressed={shown}
          aria-label={shown ? t("DashboardCustody.hideSecret") : t("DashboardCustody.showSecret")}
          onClick={() => setShown((current) => !current)}
        >
          {shown ? t("DashboardCustody.secretHide") : t("DashboardCustody.secretShow")}
        </Button>
      </div>
      {hint ? (
        <p id={hintId} className="text-meta text-tertiary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
