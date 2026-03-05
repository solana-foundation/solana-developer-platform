"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import type { IdentityValidation, TemplateSelection, TokenDraft } from "./create-token-modal.types";
import { normalizeSymbol } from "./create-token-modal.utils";

interface CreateTokenIdentityStepProps {
  template: TemplateSelection;
  draft: TokenDraft;
  decimalOptions: ReadonlyArray<TokenDraft["decimals"]>;
  validation: IdentityValidation;
  canContinue: boolean;
  onDraftChange: (patch: Partial<TokenDraft>) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function CreateTokenIdentityStep({
  template,
  draft,
  decimalOptions,
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
            <Label htmlFor="issuance-token-uri">
              Metadata URI{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </Label>
            <Input
              id="issuance-token-uri"
              type="url"
              value={draft.uri}
              onChange={(event) => onDraftChange({ uri: event.currentTarget.value })}
              placeholder="https://example.com/metadata.json"
              aria-invalid={draft.uri.length > 0 && !validation.uriValid}
              required
            />
          </div>

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
            <Label>
              Decimals{" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </Label>
            <div
              aria-required="true"
              className={[
                "grid gap-2",
                decimalOptions.length > 1 ? "grid-cols-2" : "grid-cols-1",
              ].join(" ")}
            >
              {decimalOptions.map((value) => {
                const isSelected = draft.decimals === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onDraftChange({ decimals: value })}
                    className={[
                      "h-10 rounded-lg border px-3 text-sm font-medium transition-colors",
                      isSelected
                        ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]"
                        : "border-[rgba(28,28,29,0.16)] bg-white text-[rgba(28,28,29,0.72)] hover:bg-[rgba(28,28,29,0.03)]",
                    ].join(" ")}
                  >
                    {value}
                  </button>
                );
              })}
            </div>
            <p className="text-base text-[rgba(28,28,29,0.62)]">
              {template === "stablecoin"
                ? "Stablecoin defaults to 6 decimals."
                : template === "custom"
                  ? "Custom tokens default to 9 decimals."
                  : template === "tokenized-security"
                    ? "Tokenized Security uses 8 decimals."
                    : "Arcade tokens commonly use 0 decimals."}
            </p>
          </div>
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
