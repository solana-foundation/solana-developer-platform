"use client";

import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  return (
    <motion.div
      key="identity-step"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="px-6 pb-6"
    >
      <div className="space-y-5 rounded-[28px] bg-white p-5">
        <p className="text-sm text-[rgba(28,28,29,0.62)]">Fields marked * are required.</p>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="issuance-token-name">
              Token Name{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </Label>
            <Input
              id="issuance-token-name"
              value={draft.name}
              onChange={(event) => onDraftChange({ name: event.currentTarget.value })}
              placeholder="e.g., USD Coin"
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="issuance-token-symbol">
              Symbol{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </Label>
            <Input
              id="issuance-token-symbol"
              value={draft.symbol}
              onChange={(event) =>
                onDraftChange({ symbol: normalizeSymbol(event.currentTarget.value) })
              }
              placeholder="e.g., USDC"
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="issuance-token-decimals">
              Decimals{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> (required)</span>
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
              placeholder="e.g., 6"
              aria-invalid={draft.decimals.length > 0 && !validation.decimalsValid}
              required
            />
            {draft.decimals.length > 0 && !validation.decimalsValid ? (
              <p className="text-sm text-[#c71f37]" role="alert">
                Enter a whole number between 0 and 18.
              </p>
            ) : null}
            <p className="text-base text-[rgba(28,28,29,0.62)]">
              {getDecimalsHelperText(template)}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] p-4">
          <p className="text-sm text-[rgba(28,28,29,0.62)]">
            SDP will host the metadata JSON for this token automatically. You can override the URL
            under Advanced if you&apos;d like to host your own.
          </p>

          <details className="mt-3 group">
            <summary className="cursor-pointer list-none text-sm font-medium text-[#1c1c1d] [&::-webkit-details-marker]:hidden">
              Advanced
            </summary>
            <div className="mt-3 grid gap-2">
              <Label htmlFor="issuance-token-uri">Metadata URI (optional)</Label>
              <Input
                id="issuance-token-uri"
                type="url"
                value={draft.uri}
                onChange={(event) => onDraftChange({ uri: event.currentTarget.value })}
                placeholder="https://example.com/metadata.json"
                aria-invalid={draft.uri.length > 0 && !validation.uriValid}
              />
              {draft.uri.length > 0 && !validation.uriValid ? (
                <p className="text-sm text-[#c71f37]" role="alert">
                  Enter a valid http or https URL, or leave blank to use SDP-hosted metadata.
                </p>
              ) : null}
            </div>
          </details>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={onBack} className="flex-1">
            Back
          </Button>
          <Button type="button" onClick={onContinue} disabled={!canContinue} className="flex-1">
            Continue
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
