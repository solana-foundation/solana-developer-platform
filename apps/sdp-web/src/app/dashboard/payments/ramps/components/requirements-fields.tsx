"use client";

import type { CollectedFieldData, RequirementField } from "@sdp/types/ramp-requirements";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyRequirementMask, requirementFieldError } from "../schema";

function RequirementFieldInput({
  field,
  value,
  onChange,
}: {
  field: RequirementField;
  value: string;
  onChange: (value: string) => void;
}) {
  switch (field.kind) {
    case "select":
      return (
        <Combobox
          label={field.label}
          value={value.length > 0 ? value : null}
          onChange={onChange}
          options={field.options}
          placeholder={`Select ${field.label.toLowerCase()}`}
          searchPlaceholder="Search…"
        />
      );
    case "text": {
      const error = value.trim().length > 0 ? requirementFieldError(field, value) : null;
      return (
        <div className="space-y-2">
          <Label htmlFor={field.key}>{field.label}</Label>
          <Input
            size="xl"
            id={field.key}
            placeholder={field.placeholder}
            value={value}
            onChange={(event) =>
              onChange(
                field.mask
                  ? applyRequirementMask(field.mask, event.target.value)
                  : event.target.value
              )
            }
          />
          {error ? <p className="text-sm text-status-error-text">{error}</p> : null}
        </div>
      );
    }
    default: {
      const exhaustive: never = field;
      throw new Error(`Unhandled requirement field kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function RequirementsFields({
  fields,
  values,
  onChange,
}: {
  fields: RequirementField[];
  values: CollectedFieldData;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-6">
      {fields.map((field) => {
        const current = values[field.key];
        return (
          <RequirementFieldInput
            key={field.key}
            field={field}
            value={current === undefined ? "" : current}
            onChange={(value) => onChange(field.key, value)}
          />
        );
      })}
    </div>
  );
}
