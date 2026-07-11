"use client";

import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import type { IdentityValidation, TemplateSelection, TokenDraft } from "./create-token-modal.types";
import { getDecimalsHelperText, normalizeSymbol } from "./create-token-modal.utils";

interface CreateTokenIdentityStepProps {
  template: TemplateSelection;
  draft: TokenDraft;
  validation: IdentityValidation;
  canContinue: boolean;
  onDraftChange: (patch: Partial<TokenDraft>) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function CreateTokenIdentityStep({
  template,
  draft,
  validation,
  canContinue,
  onDraftChange,
  onBack,
  onContinue,
}: CreateTokenIdentityStepProps) {
  const t = useTranslations();
  return (
    <motion.div
      key="identity-step"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="px-6 pb-6"
    >
      <div className="space-y-5 rounded-[28px] bg-white p-5">
        <p className="text-sm text-[rgba(28,28,29,0.62)]">{t("DashboardIssuance.create.requiredFields")}</p>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="issuance-token-name">
              {t("DashboardIssuance.create.tokenName")}{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> {t("DashboardIssuance.create.required")}</span>
            </Label>
            <Input
              id="issuance-token-name"
              value={draft.name}
              onChange={(event) => onDraftChange({ name: event.currentTarget.value })}
              placeholder={t("DashboardIssuance.create.tokenNamePlaceholder")}
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="issuance-token-symbol">
              {t("DashboardIssuance.create.symbol")}{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> {t("DashboardIssuance.create.required")}</span>
            </Label>
            <Input
              id="issuance-token-symbol"
              value={draft.symbol}
              onChange={(event) =>
                onDraftChange({ symbol: normalizeSymbol(event.currentTarget.value) })
              }
              placeholder={t("DashboardIssuance.create.symbolPlaceholder")}
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="issuance-token-decimals">
              {t("DashboardIssuance.create.decimals")}{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> {t("DashboardIssuance.create.required")}</span>
            </Label>
            <Input
              id="issuance-token-decimals"
              type="number"
              min="0"
              max="18"
              step="1"
              inputMode="numeric"
              value={draft.decimals}
              onChange={(event) => onDraftChange({ decimals: event.currentTarget.value })}
              placeholder={t("DashboardIssuance.create.decimalsPlaceholder")}
              aria-invalid={draft.decimals.length > 0 && !validation.decimalsValid}
              required
            />
            {draft.decimals.length > 0 && !validation.decimalsValid ? (
              <p className="text-sm text-[#c71f37]" role="alert">
                {t("DashboardIssuance.create.decimalsError")}
              </p>
            ) : null}
            <p className="text-base text-[rgba(28,28,29,0.62)]">
              {getDecimalsHelperText(template)}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={onBack} className="flex-1">
            {t("DashboardIssuance.create.back")}
          </Button>
          <Button type="button" onClick={onContinue} disabled={!canContinue} className="flex-1">
            {t("DashboardIssuance.create.continue")}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
