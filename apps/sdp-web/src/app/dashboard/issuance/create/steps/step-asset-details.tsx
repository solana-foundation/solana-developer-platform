"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { Plus, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AdvancedCapacities } from "../advanced-capacities";
import {
  ACCESS_CONTROL_OPTIONS,
  type FieldDescriptor,
  getCategorySections,
} from "../asset-details-config";
import { DocumentRows } from "../document-rows";
import { buildIssuanceMetadata } from "../draft-mapping";
import type { CustomFieldRow, DraftState } from "../issuance-draft-wizard.types";
import { MetadataJsonPanel, MetadataJsonToggle } from "../metadata-json";
import { useIssuanceDraft } from "../use-issuance-draft";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "compliance", label: "Compliance & Access" },
  { id: "operational", label: "Operational" },
  { id: "custom", label: "Custom fields" },
] as const;

type UpdateDraft = (patch: Partial<DraftState>) => void;

export function StepAssetDetails() {
  const { draft, updateDraft } = useIssuanceDraft();
  const [tab, setTab] = useState<string>("overview");
  const [jsonOpen, setJsonOpen] = useState(false);
  const sections = getCategorySections(draft.assetCategory);
  const metadata = buildIssuanceMetadata(draft);

  return (
    <motion.div
      key="asset-details-form"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-medium text-[#1c1c1d]">Asset details</h2>
          <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
            Add the key information about this asset. You can update these details any time.
          </p>
        </div>
        <MetadataJsonToggle open={jsonOpen} onToggle={() => setJsonOpen((prev) => !prev)} />
      </div>

      {jsonOpen ? <MetadataJsonPanel metadata={metadata} /> : null}

      <p className="text-xs text-[rgba(28,28,29,0.55)]">
        This information is private by default and won&apos;t be visible to the public unless you
        choose to include it.
      </p>

      <Tabs bordered value={tab} onValueChange={(value) => setTab(value)}>
        <TabList>
          {TABS.map((entry) => (
            <Tab key={entry.id} value={entry.id}>
              {entry.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      {tab === "overview" ? (
        <div className="space-y-5">
          <FormCard
            title="About this asset"
            description="Basic information that describes what this asset is."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Symbol"
                value={draft.symbol}
                onChange={(value) => updateDraft({ symbol: value })}
                placeholder="e.g., vUSD"
              />
              <TextField
                label="Decimals"
                type="number"
                value={draft.decimals}
                onChange={(value) => updateDraft({ decimals: value })}
                placeholder="e.g., 6"
              />
            </div>
            <div className="mt-4 grid gap-1.5">
              <Label htmlFor="asset-description">Description</Label>
              <textarea
                id="asset-description"
                value={draft.description}
                onChange={(event) => updateDraft({ description: event.currentTarget.value })}
                rows={3}
                placeholder="Describe what this asset represents."
                className="w-full rounded-[14px] border border-[rgba(28,28,29,0.14)] bg-white px-4 py-3 text-sm text-[#1c1c1d] outline-none transition-[box-shadow,border-color] placeholder:text-[rgba(28,28,29,0.4)] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)]"
              />
            </div>
            <div className="mt-4 max-w-md">
              <TextField
                label="Website"
                value={draft.website}
                onChange={(value) => updateDraft({ website: value })}
                placeholder="https://…"
              />
            </div>
          </FormCard>

          {sections.map((section) => (
            <FormCard key={section.title} title={section.title} description={section.description}>
              <div className="grid gap-4 sm:grid-cols-2">
                {section.fields.map((field) => (
                  <DetailField
                    key={field.key}
                    field={field}
                    draft={draft}
                    updateDraft={updateDraft}
                  />
                ))}
              </div>
            </FormCard>
          ))}

          <FormCard
            title="Documents & references"
            description="Important documents and references related to this asset."
          >
            <DocumentRows
              documents={draft.documents}
              onChange={(documents) => updateDraft({ documents })}
            />
          </FormCard>
        </div>
      ) : null}

      {tab === "compliance" ? (
        <div className="space-y-5">
          <FormCard
            title="Access control"
            description="Choose how this token treats approved or blocked destination addresses."
          >
            <div className="max-w-xs">
              <Label>Access control</Label>
              <div className="mt-1.5">
                <Select
                  value={draft.accessControl || null}
                  onValueChange={(value) =>
                    updateDraft({ accessControl: (value ?? "") as DraftState["accessControl"] })
                  }
                  placeholder="Select access control"
                >
                  {ACCESS_CONTROL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </div>
          </FormCard>
          <AdvancedCapacities
            value={draft.capacities}
            onChange={(key, checked) =>
              updateDraft({ capacities: { ...draft.capacities, [key]: checked } })
            }
          />
        </div>
      ) : null}

      {tab === "operational" ? (
        <FormCard title="Operational" description="Optional operational settings.">
          <div className="grid gap-4">
            <TextField
              label="Signing wallet ID (optional)"
              value={draft.signingWalletId}
              onChange={(value) => updateDraft({ signingWalletId: value })}
              placeholder="wal_…"
              help="Leave blank to use the project's default signer."
            />
            <TextField
              label="Metadata URI (optional)"
              value={draft.metadataUri}
              onChange={(value) => updateDraft({ metadataUri: value })}
              placeholder="https://…/metadata.json"
              help="Leave blank to use SDP-hosted metadata."
            />
          </div>
        </FormCard>
      ) : null}

      {tab === "custom" ? (
        <FormCard
          title="Custom fields"
          description="Add your own private fields, stored under custom.customer."
        >
          <CustomFieldRows
            fields={draft.customFields}
            onChange={(customFields) => updateDraft({ customFields })}
          />
        </FormCard>
      ) : null}
    </motion.div>
  );
}

function FormCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
      <p className="text-base font-medium text-[#1c1c1d]">{title}</p>
      {description ? (
        <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  help?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
      />
      {help ? <p className="text-xs text-[rgba(28,28,29,0.5)]">{help}</p> : null}
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        checked ? "bg-[#1c1c1d]" : "bg-[rgba(28,28,29,0.2)]"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

function DetailField({
  field,
  draft,
  updateDraft,
}: {
  field: FieldDescriptor;
  draft: DraftState;
  updateDraft: UpdateDraft;
}) {
  const raw = draft[field.key];

  if (field.control === "toggle") {
    const checked = Boolean(raw);
    return (
      <div>
        <Label>{field.label}</Label>
        <div className="mt-1.5 flex items-center gap-2">
          <ToggleSwitch
            checked={checked}
            onChange={(next) => updateDraft({ [field.key]: next } as Partial<DraftState>)}
          />
          <span className="text-sm text-[rgba(28,28,29,0.6)]">
            {checked ? "Enabled" : "Disabled"}
          </span>
        </div>
        {field.help ? <p className="mt-1 text-xs text-[rgba(28,28,29,0.5)]">{field.help}</p> : null}
      </div>
    );
  }

  if (field.control === "select") {
    const value = typeof raw === "string" ? raw : "";
    return (
      <div>
        <Label>{field.label}</Label>
        <div className="mt-1.5">
          <Select
            value={value || null}
            onValueChange={(next) =>
              updateDraft({ [field.key]: next ?? "" } as Partial<DraftState>)
            }
            placeholder={`Select ${field.label.toLowerCase()}`}
          >
            {field.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
    );
  }

  const value = typeof raw === "string" ? raw : "";
  return (
    <TextField
      label={field.label}
      value={value}
      onChange={(next) => updateDraft({ [field.key]: next } as Partial<DraftState>)}
      placeholder={field.placeholder}
      type={field.control === "number" ? "number" : "text"}
      help={field.help}
    />
  );
}

function CustomFieldRows({
  fields,
  onChange,
}: {
  fields: CustomFieldRow[];
  onChange: (fields: CustomFieldRow[]) => void;
}) {
  const update = (id: string, patch: Partial<CustomFieldRow>) =>
    onChange(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  const remove = (id: string) => onChange(fields.filter((field) => field.id !== id));

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div
          key={field.id}
          className="grid grid-cols-1 gap-2 rounded-xl border border-[rgba(28,28,29,0.1)] bg-white p-3 sm:grid-cols-[1fr_1.4fr_auto]"
        >
          <Input
            placeholder="Key"
            value={field.key}
            onChange={(event) => update(field.id, { key: event.currentTarget.value })}
          />
          <Input
            placeholder="Value"
            value={field.value}
            onChange={(event) => update(field.id, { value: event.currentTarget.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => remove(field.id)}
            aria-label="Remove field"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onChange([...fields, { id: crypto.randomUUID(), key: "", value: "" }])}
        iconLeft={<Plus className="h-4 w-4" />}
      >
        Add field
      </Button>
    </div>
  );
}
