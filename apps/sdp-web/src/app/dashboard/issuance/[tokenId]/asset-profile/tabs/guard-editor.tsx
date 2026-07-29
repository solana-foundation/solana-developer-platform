"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { type GuardDraft, type GuardOperator, humanizeType } from "../workflows.data";

// GUARD ("only if…") editor: a repeatable list of [field ▾][operator ▾][value] rows the
// user can add/remove. `field` options come from the selected trigger's conditionFields;
// `in` values are comma-separated. The parent owns the guard state and turns filled rows
// into a WorkflowCondition at submit; incomplete rows block submit (never silently drop).

const GUARD_OPERATORS: Array<{ value: GuardOperator; labelKey: string }> = [
  { value: "eq", labelKey: "guardIs" },
  { value: "neq", labelKey: "guardIsNot" },
  { value: "in", labelKey: "guardIsOneOf" },
];

// Closed-enum condition fields get a value dropdown instead of free text — the engine
// compares with strict equality, so a typo would silently never match.
const FIELD_VALUE_OPTIONS: Record<string, string[]> = {
  operation: [
    "mint",
    "burn",
    "force_burn",
    "freeze",
    "unfreeze",
    "pause",
    "unpause",
    "seize",
    "update_authority",
  ],
};

export function GuardEditor({
  conditionFields,
  guards,
  onAdd,
  onUpdate,
  onRemove,
}: {
  conditionFields: string[];
  guards: GuardDraft[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<GuardDraft>) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations();
  const wf = (k: string) => {
    try {
      return t(`DashboardIssuance.workflows.${k}` as Parameters<typeof t>[0]);
    } catch {
      return k;
    }
  };
  const fieldLabel = (field: string): string => {
    try {
      return t(
        `DashboardIssuance.workflows.conditionFieldLabels.${field}` as Parameters<typeof t>[0]
      );
    } catch {
      return humanizeType(field);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-border-subtle bg-fill-subtle/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-secondary">{wf("guardTitle")}</span>
        {conditionFields.length > 0 ? (
          <Button type="button" size="sm" variant="ghost" onClick={onAdd}>
            {wf("guardAdd")}
          </Button>
        ) : null}
      </div>

      {conditionFields.length === 0 ? (
        <p className="text-xs text-tertiary">{wf("guardNoFields")}</p>
      ) : guards.length === 0 ? (
        <p className="text-xs text-tertiary">{wf("guardEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {guards.map((guard) => {
            const valueOptions = guard.op === "in" ? null : FIELD_VALUE_OPTIONS[guard.field];
            const incomplete = guard.value.trim().length === 0;
            return (
              <li key={guard.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-[7rem] flex-1">
                    <Select
                      ariaLabel={wf("guardFieldAria")}
                      value={guard.field}
                      onValueChange={(v) => onUpdate(guard.id, { field: v ?? "", value: "" })}
                    >
                      {conditionFields.map((field) => (
                        <SelectItem key={field} value={field}>
                          {fieldLabel(field)}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                  <div className="min-w-[6rem]">
                    <Select
                      ariaLabel={wf("guardOperatorAria")}
                      value={guard.op}
                      onValueChange={(v) =>
                        onUpdate(guard.id, { op: (v ?? "eq") as GuardOperator })
                      }
                    >
                      {GUARD_OPERATORS.map((op) => (
                        <SelectItem key={op.value} value={op.value}>
                          {wf(op.labelKey)}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                  {valueOptions ? (
                    <div className="min-w-[8rem] flex-1">
                      <Select
                        ariaLabel={wf("guardValueAria")}
                        value={guard.value || null}
                        placeholder={wf("guardValuePlaceholder")}
                        onValueChange={(v) => onUpdate(guard.id, { value: v ?? "" })}
                      >
                        {valueOptions.map((value) => (
                          <SelectItem key={value} value={value}>
                            {humanizeType(value)}
                          </SelectItem>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <Input
                        aria-label={wf("guardValueAria")}
                        value={guard.value}
                        onChange={(e) => onUpdate(guard.id, { value: e.target.value })}
                        placeholder={
                          guard.op === "in"
                            ? wf("guardValueListPlaceholder")
                            : wf("guardValuePlaceholder")
                        }
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(guard.id)}
                    aria-label={wf("guardRemove")}
                    className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {incomplete ? (
                  <p className="text-xs text-warning">{wf("guardIncomplete")}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
