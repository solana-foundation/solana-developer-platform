"use client";

import { Button } from "@/components/ui/button";
import { AnimatePresence, motion } from "framer-motion";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { FormEvent } from "react";
import type { CreateIssuanceTokenResult } from "./actions";
import type { AccessControlMode, TemplateSelection, TokenDraft } from "./create-token-modal.types";
import {
  getAccessControlAvailability,
  getCreateButtonLabel,
  toRequiresAllowlist,
} from "./create-token-modal.utils";

interface CreateTokenFeaturesStepProps {
  template: TemplateSelection;
  draft: TokenDraft;
  submitState: CreateIssuanceTokenResult;
  isPending: boolean;
  canSubmit: boolean;
  onAccessControlModeChange: (mode: AccessControlMode) => void;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function CreateTokenFeaturesStep({
  template,
  draft,
  submitState,
  isPending,
  canSubmit,
  onAccessControlModeChange,
  onBack,
  onSubmit,
}: CreateTokenFeaturesStepProps) {
  const allowlistAvailability = getAccessControlAvailability(template, "allowlist");
  const blocklistAvailability = getAccessControlAvailability(template, "blocklist");

  return (
    <motion.form
      key="features-step"
      onSubmit={onSubmit}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="px-6 pb-6"
    >
      <input type="hidden" name="template" value={template} />
      <input type="hidden" name="uri" value={draft.uri.trim()} />
      <input type="hidden" name="name" value={draft.name.trim()} />
      <input type="hidden" name="symbol" value={draft.symbol.trim()} />
      <input type="hidden" name="decimals" value={draft.decimals} />
      <input
        type="hidden"
        name="requiresAllowlist"
        value={String(toRequiresAllowlist(template, draft.accessControlMode))}
      />

      <div className="space-y-5 rounded-[28px] p-5">
        <div>
          <p className="text-3xl font-medium text-[#1c1c1d]">
            Access Control Mode{" "}
            <span aria-hidden className="text-[#c71f37]">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </p>
          <p className="mt-2 text-lg text-[rgba(28,28,29,0.64)]">
            Configure transfer restrictions for the selected template.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <AccessControlOption
            title="Allowlist"
            description="Only approved addresses can transfer"
            icon={<ShieldCheck className="h-6 w-6 text-[#1c1c1d]" />}
            availability={allowlistAvailability}
            isSelected={draft.accessControlMode === "allowlist"}
            onSelect={() => onAccessControlModeChange("allowlist")}
          />
          <AccessControlOption
            title="Blocklist"
            description="Block specific addresses from transfers"
            icon={<ShieldAlert className="h-6 w-6 text-[#1c1c1d]" />}
            availability={blocklistAvailability}
            isSelected={draft.accessControlMode === "blocklist"}
            onSelect={() => onAccessControlModeChange("blocklist")}
          />
        </div>
      </div>

      <AnimatePresence>
        {submitState.state === "error" && submitState.message ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mt-4 rounded-2xl border border-[#c71f37]/30 bg-[#c71f37]/6 px-4 py-3 text-base text-[#8a1f2a]"
          >
            {submitState.message}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="mt-5 flex items-center justify-between gap-3">
        <Button type="button" variant="secondary" onClick={onBack} className="flex-1">
          Back
        </Button>
        <Button type="submit" disabled={!canSubmit} className="flex-1">
          {isPending ? "Creating..." : getCreateButtonLabel(template)}
        </Button>
      </div>
    </motion.form>
  );
}

function AccessControlOption({
  title,
  description,
  icon,
  availability,
  isSelected,
  onSelect,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  availability: {
    available: boolean;
    note: string;
  };
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!availability.available) {
          return;
        }
        onSelect();
      }}
      aria-disabled={!availability.available}
      className={[
        "rounded-3xl border p-5 text-left transition-colors",
        isSelected
          ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)]"
          : "border-[rgba(28,28,29,0.14)] bg-white",
        availability.available
          ? "cursor-pointer hover:bg-[rgba(28,28,29,0.03)]"
          : "cursor-not-allowed opacity-60",
      ].join(" ")}
    >
      {icon}
      <p className="mt-4 text-2xl font-semibold text-[#1c1c1d]">{title}</p>
      <p className="mt-2 text-base text-[rgba(28,28,29,0.66)]">{description}</p>
      <p className="mt-2 text-sm text-[rgba(28,28,29,0.58)]">{availability.note}</p>
    </button>
  );
}
