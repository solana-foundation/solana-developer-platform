"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { type GuardDraft, type GuardOperator, humanizeType } from "../workflows.data";

// GUARD ("only if…") editor: a repeatable list of [field ▾][operator ▾][value] rows the
// user can add/remove. `field` options come from the selected trigger's conditionFields;
// `in` values are comma-separated. The parent owns the guard state and turns filled rows
// into a WorkflowCondition at submit.

const GUARD_OPERATORS: Array<{ value: GuardOperator; labelKey: string }> = [
  { value: "eq", labelKey: "guardIs" },
  { value: "neq", labelKey: "guardIsNot" },
  { value: "in", labelKey: "guardIsOneOf" },
];

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
  onUpdate: (index: number, patch: Partial<GuardDraft>) => void;
  onRemove: (index: number) => void;
}) {
  const t = useTranslations();
  const wf = (k: string) => t(`DashboardIssuance.workflows.${k}` as Parameters<typeof t>[0]);
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
          {guards.map((guard, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and reorder-free
            <li key={index} className="flex flex-wrap items-center gap-2">
              <div className="min-w-[7rem] flex-1">
                <Select
                  value={guard.field}
                  onValueChange={(v) => onUpdate(index, { field: v ?? "" })}
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
                  value={guard.op}
                  onValueChange={(v) => onUpdate(index, { op: (v ?? "eq") as GuardOperator })}
                >
                  {GUARD_OPERATORS.map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {wf(op.labelKey)}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <input
                value={guard.value}
                onChange={(e) => onUpdate(index, { value: e.target.value })}
                placeholder={
                  guard.op === "in" ? wf("guardValueListPlaceholder") : wf("guardValuePlaceholder")
                }
                className="min-w-0 flex-1 rounded-lg border border-border-default bg-white px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={wf("guardRemove")}
                className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
