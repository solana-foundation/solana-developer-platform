"use client";
import type { FireblocksPolicyForm, FireblocksPolicySetup } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";

function PeoplePicker({
  label,
  people,
  selected,
  onChange,
  disabled,
  single = false,
}: {
  label: string;
  people: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  single?: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <Combobox
        label={label}
        value={single ? (selected[0] ?? null) : null}
        disabled={disabled}
        options={people
          .filter((p) => single || !selected.includes(p.id))
          .map((p) => ({ value: p.id, label: p.name }))}
        onChange={(id) => onChange(single ? [id] : [...selected, id])}
        placeholder={t("DashboardPayments.fireblocksPolicy.choosePeople")}
      />
      {!single && selected.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {selected.map((id) => (
            <li key={id} className="flex items-center justify-between gap-3">
              <span>{people.find((p) => p.id === id)?.name ?? id}</span>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(selected.filter((value) => value !== id))}
              >
                {t("DashboardPayments.fireblocksPolicy.remove", {
                  name: people.find((p) => p.id === id)?.name ?? id,
                })}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
function ApprovalSets({
  setup,
  form,
  onChange,
  disabled,
}: {
  setup: FireblocksPolicySetup;
  form: FireblocksPolicyForm;
  onChange: (form: FireblocksPolicyForm) => void;
  disabled: boolean;
}) {
  const t = useTranslations();
  const changeSet = (index: number, set: FireblocksPolicyForm["approvalGroups"][number]) =>
    onChange({
      ...form,
      approvalGroups: form.approvalGroups.map((value, i) => (i === index ? set : value)),
    });
  return (
    <div className="space-y-5">
      {form.approvalGroups.map((set, index) => {
        const group = setup.groups.find((g) => g.id === set.groups[0]);
        const count = group ? group.memberIds.length : set.users.length;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: Ordered, fully controlled approval slots have no independent field state.
            key={`approval-set-${index}`}
            className="space-y-3 border-t border-border-default pt-4"
          >
            <Combobox
              label={t("DashboardPayments.fireblocksPolicy.approverSet", { number: index + 1 })}
              disabled={disabled}
              value={group?.id ?? "custom"}
              options={[
                { value: "custom", label: t("DashboardPayments.fireblocksPolicy.selectUsers") },
                ...setup.groups.map((g) => ({ value: g.id, label: g.name })),
              ]}
              onChange={(id) =>
                changeSet(index, { users: [], groups: id === "custom" ? [] : [id], threshold: 1 })
              }
            />
            {!group ? (
              <PeoplePicker
                label={t("DashboardPayments.fireblocksPolicy.approvers")}
                people={setup.people}
                selected={set.users}
                disabled={disabled}
                onChange={(users) =>
                  changeSet(index, {
                    ...set,
                    users,
                    threshold: Math.min(set.threshold, Math.max(1, users.length)),
                  })
                }
              />
            ) : (
              <p className="text-sm text-secondary">
                {group.memberIds
                  .map((id) => setup.people.find((p) => p.id === id)?.name)
                  .filter(Boolean)
                  .join(", ")}
              </p>
            )}
            <Combobox
              label={t("DashboardPayments.fireblocksPolicy.threshold")}
              disabled={disabled || count === 0}
              value={String(set.threshold)}
              options={Array.from({ length: Math.max(1, count) }, (_, i) => ({
                value: String(i + 1),
                label: t("DashboardPayments.fireblocksPolicy.thresholdValue", {
                  required: i + 1,
                  total: count,
                }),
              }))}
              onChange={(value) => changeSet(index, { ...set, threshold: Number(value) })}
            />
            {form.approvalGroups.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...form,
                    approvalGroups: form.approvalGroups.filter((_, i) => i !== index),
                  })
                }
              >
                {t("DashboardPayments.fireblocksPolicy.removeSet")}
              </Button>
            ) : null}
          </div>
        );
      })}
      {form.approvalGroups.length < 5 ? (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...form,
              approvalGroups: [...form.approvalGroups, { users: [], groups: [], threshold: 1 }],
            })
          }
        >
          {t("DashboardPayments.fireblocksPolicy.addSet")}
        </Button>
      ) : null}
      {form.approvalGroups.length > 1 ? (
        <Combobox
          label={t("DashboardPayments.fireblocksPolicy.setOperator")}
          disabled={disabled}
          value={form.approvalOperator}
          options={[
            { value: "AND", label: t("DashboardPayments.fireblocksPolicy.allSets") },
            { value: "OR", label: t("DashboardPayments.fireblocksPolicy.anySet") },
          ]}
          onChange={(value) => onChange({ ...form, approvalOperator: value as "AND" | "OR" })}
        />
      ) : null}
    </div>
  );
}
export function fireblocksPolicyFormReady(
  form: FireblocksPolicyForm,
  setup: FireblocksPolicySetup
) {
  return (
    form.name.startsWith("Created within SDP — ") &&
    form.signerIds.length > 0 &&
    (form.signerMode !== "SINGLE" || form.signerIds.length === 1) &&
    form.approvalGroups.every((set) => {
      const count = new Set([
        ...set.users,
        ...set.groups.flatMap((id) => setup.groups.find((g) => g.id === id)?.memberIds ?? []),
      ]).size;
      return set.threshold > 0 && set.threshold <= count;
    })
  );
}
export function FireblocksPolicyFields({
  setup,
  form,
  onChange,
  disabled,
}: {
  setup: FireblocksPolicySetup;
  form: FireblocksPolicyForm;
  onChange: (form: FireblocksPolicyForm) => void;
  disabled: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="fireblocks-policy-name">
          {t("DashboardPayments.fireblocksPolicy.ruleName")}
        </Label>
        <Input
          id="fireblocks-policy-name"
          value={form.name}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <dt className="text-secondary">{t("DashboardPayments.fireblocksPolicy.initiator")}</dt>
        <dd>{setup.initiatorName}</dd>
        <dt className="text-secondary">{t("DashboardPayments.fireblocksPolicy.source")}</dt>
        <dd>{setup.sourceName}</dd>
        <dt className="text-secondary">{t("DashboardPayments.fireblocksPolicy.asset")}</dt>
        <dd>{setup.assetId}</dd>
      </dl>
      <Combobox
        label={t("DashboardPayments.fireblocksPolicy.destination")}
        disabled={disabled}
        value={form.destination}
        options={[
          {
            value: "all_whitelisted",
            label: t("DashboardPayments.fireblocksPolicy.allWhitelisted"),
          },
          {
            value: "selected_whitelisted",
            label: t("DashboardPayments.fireblocksPolicy.selectedWhitelisted"),
            disabled: !setup.destinationWhitelisted,
          },
          { value: "one_time", label: t("DashboardPayments.fireblocksPolicy.oneTime") },
        ]}
        onChange={(value) =>
          onChange({ ...form, destination: value as FireblocksPolicyForm["destination"] })
        }
      />
      {!setup.destinationWhitelisted && form.destination !== "one_time" ? (
        <p className="text-sm text-secondary">
          {t("DashboardPayments.fireblocksPolicy.whitelistFirst")}
        </p>
      ) : null}
      {form.destination === "one_time" ? (
        <p className="text-sm text-secondary">
          {t("DashboardPayments.fireblocksPolicy.oneTimeHint")}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <dt className="text-secondary">{t("DashboardPayments.fireblocksPolicy.minimum")}</dt>
        <dd>0 USD</dd>
        <dt className="text-secondary">{t("DashboardPayments.fireblocksPolicy.maximum")}</dt>
        <dd>{t("DashboardPayments.fireblocksPolicy.unlimited")}</dd>
        <dt className="text-secondary">{t("DashboardPayments.fireblocksPolicy.limit")}</dt>
        <dd>{t("DashboardPayments.fireblocksPolicy.singleTransaction")}</dd>
        <dt className="text-secondary">{t("DashboardPayments.fireblocksPolicy.action")}</dt>
        <dd>{t("DashboardPayments.fireblocksPolicy.requestApproval")}</dd>
        <dt className="text-secondary">
          {t("DashboardPayments.fireblocksPolicy.initiatorApproval")}
        </dt>
        <dd>{t("DashboardPayments.fireblocksPolicy.cannotApprove")}</dd>
      </dl>
      <ApprovalSets setup={setup} form={form} onChange={onChange} disabled={disabled} />
      <div className="space-y-3 border-t border-border-default pt-4">
        <Combobox
          label={t("DashboardPayments.fireblocksPolicy.designatedSigner")}
          disabled={disabled}
          value={form.signerMode}
          options={[
            { value: "SINGLE", label: t("DashboardPayments.fireblocksPolicy.singleUser") },
            { value: "MULTIPLE", label: t("DashboardPayments.fireblocksPolicy.multipleUsers") },
          ]}
          onChange={(value) =>
            onChange({
              ...form,
              signerMode: value as "SINGLE" | "MULTIPLE",
              signerIds: value === "SINGLE" ? form.signerIds.slice(0, 1) : form.signerIds,
            })
          }
        />
        <PeoplePicker
          label={t("DashboardPayments.fireblocksPolicy.signers")}
          people={setup.people.filter((p) => p.canSign)}
          selected={form.signerIds}
          single={form.signerMode === "SINGLE"}
          disabled={disabled}
          onChange={(signerIds) => onChange({ ...form, signerIds })}
        />
        <p className="text-sm text-secondary">
          {t("DashboardPayments.fireblocksPolicy.signerHint")}
        </p>
      </div>
    </div>
  );
}
