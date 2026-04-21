"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { CreateIssuanceTokenResult } from "./actions";
import type { AccessControlMode, TemplateSelection, TokenDraft } from "./create-token-modal.types";
import {
  getAccessControlOptions,
  getCreateButtonLabel,
  toRequiresAllowlist,
} from "./create-token-modal.utils";

interface CreateTokenFeaturesStepProps {
  template: TemplateSelection;
  draft: TokenDraft;
  signerWallets: PaymentsDashboardWallet[];
  signerWalletsLoading: boolean;
  signerWalletsError: string | null;
  submitState: CreateIssuanceTokenResult;
  isPending: boolean;
  canSubmit: boolean;
  onAccessControlModeChange: (mode: AccessControlMode) => void;
  onSigningWalletChange: (walletId: string) => void;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function CreateTokenFeaturesStep({
  template,
  draft,
  signerWallets,
  signerWalletsLoading,
  signerWalletsError,
  submitState,
  isPending,
  canSubmit,
  onAccessControlModeChange,
  onSigningWalletChange,
  onBack,
  onSubmit,
}: CreateTokenFeaturesStepProps) {
  const accessControlOptions = getAccessControlOptions(template);
  const availableSignerWallets = signerWallets.filter(
    (wallet) => wallet.walletId.trim() && wallet.publicKey.trim()
  );

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
        value={String(toRequiresAllowlist(draft.accessControlMode))}
      />

      <div className="space-y-5 rounded-[28px] p-5">
        <div className="grid gap-2">
          <label
            htmlFor="issuance-token-main-signer"
            className="text-3xl font-medium text-[#1c1c1d]"
          >
            Main Signer
          </label>
          {availableSignerWallets.length > 0 ? (
            <>
              <select
                id="issuance-token-main-signer"
                name="signingWalletId"
                value={draft.signingWalletId}
                onChange={(event) => onSigningWalletChange(event.currentTarget.value)}
                required
                className="h-12 w-full rounded-[14px] border border-[rgba(28,28,29,0.14)] bg-white px-4 text-base text-[#1c1c1d] shadow-none outline-none transition-[box-shadow,border-color] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)]"
              >
                <option value="" disabled>
                  Select signer wallet
                </option>
                {availableSignerWallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.walletId}>
                    {wallet.label ? `${wallet.label} · ${wallet.walletId}` : wallet.walletId}
                  </option>
                ))}
              </select>
              <p className="text-base text-[rgba(28,28,29,0.62)]">
                This wallet will be used as the token&apos;s main signer for deploy and later token
                actions.
              </p>
            </>
          ) : signerWalletsLoading ? (
            <p className="rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] px-4 py-3 text-base text-[rgba(28,28,29,0.62)]">
              Loading signer wallets…
            </p>
          ) : signerWalletsError ? (
            <p className="rounded-2xl border border-[#c71f37]/20 bg-[#c71f37]/[0.03] px-4 py-3 text-base text-[#8a1f2a]">
              {signerWalletsError}
            </p>
          ) : (
            <p className="rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] px-4 py-3 text-base text-[rgba(28,28,29,0.62)]">
              No controlled wallets are available yet. The token will use the current default
              signer.
            </p>
          )}
        </div>

        <div>
          <p className="text-3xl font-medium text-[#1c1c1d]">Transfer Controls</p>
          <p className="mt-2 text-lg text-[rgba(28,28,29,0.64)]">
            Choose how this token should treat approved or blocked destination addresses.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {accessControlOptions.map((option) => (
            <AccessControlOption
              key={option.mode}
              title={option.title}
              description={option.description}
              icon={
                option.mode === "allowlist" ? (
                  <ShieldCheck className="h-6 w-6 text-[#1c1c1d]" />
                ) : (
                  <ShieldAlert className="h-6 w-6 text-[#1c1c1d]" />
                )
              }
              note={option.note}
              isSelected={draft.accessControlMode === option.mode}
              onSelect={() => onAccessControlModeChange(option.mode)}
            />
          ))}
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
  note,
  isSelected,
  onSelect,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  note: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "rounded-3xl border p-5 text-left transition-colors",
        isSelected
          ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)]"
          : "border-[rgba(28,28,29,0.14)] bg-white",
        "cursor-pointer hover:bg-[rgba(28,28,29,0.03)]",
      ].join(" ")}
    >
      {icon}
      <p className="mt-4 text-2xl font-semibold text-[#1c1c1d]">{title}</p>
      <p className="mt-2 text-base text-[rgba(28,28,29,0.66)]">{description}</p>
      <p className="mt-2 text-sm text-[rgba(28,28,29,0.58)]">{note}</p>
    </button>
  );
}
