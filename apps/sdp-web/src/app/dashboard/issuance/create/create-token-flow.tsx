"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  EyeOff,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchWallets } from "../../payments/payments-workspace.data";
import { type CreateIssuanceTokenResult, createIssuanceTokenAction } from "../actions";
import type { FlowState, TemplateSelection, TokenDraft } from "../create-token-modal.types";
import {
  createInitialDraft,
  getAccessControlOptions,
  getCreateButtonLabel,
  getDecimalsHelperText,
  getDefaultAccessControlMode,
  getTemplateDefaultDecimals,
  INITIAL_CREATE_ISSUANCE_TOKEN_RESULT,
  isAccessControlModeAvailable,
  isValidMetadataUri,
  isValidTokenDecimals,
  isValidTokenSymbol,
  normalizeSymbol,
  templateCards,
  toRequiresAllowlist,
} from "../create-token-modal.utils";

interface CreateTokenFlowProps {
  signerWallets?: PaymentsDashboardWallet[];
  signerWalletsError?: string | null;
  isDevnet?: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this component intentionally coordinates the full multi-step token creation flow (template selection, identity, features) in one place.
export function CreateTokenFlow({
  signerWallets = [],
  signerWalletsError = null,
  isDevnet = false,
}: CreateTokenFlowProps) {
  const router = useRouter();
  const [flow, setFlow] = useState<FlowState>({ kind: "templateSelection" });
  const [draft, setDraft] = useState<TokenDraft>(createInitialDraft());
  const [submitState, setSubmitState] = useState<CreateIssuanceTokenResult>(
    INITIAL_CREATE_ISSUANCE_TOKEN_RESULT
  );
  const [isPending, startTransition] = useTransition();
  const [enableConfidentialTransfers, setEnableConfidentialTransfers] = useState(false);

  const template = flow.kind === "creation" ? flow.template : draft.template;
  const uri = draft.uri.trim();
  const name = draft.name.trim();
  const symbol = draft.symbol.trim();
  const identityValidation = {
    uriValid: isValidMetadataUri(uri),
    nameValid: name.length > 0 && name.length <= 100,
    symbolValid: isValidTokenSymbol(symbol),
    decimalsValid: template !== null && isValidTokenDecimals(draft.decimals),
  };
  const isFeaturesStep = flow.kind === "creation" && flow.step === "features";
  const hasServerWalletSnapshot = signerWallets.length > 0 || signerWalletsError !== null;
  const { data: liveSignerWalletsData, error: liveSignerWalletsError } = useSWR(
    isFeaturesStep ? "issuance-create-token-signer-wallets" : null,
    () => fetchWallets(),
    {
      fallbackData: hasServerWalletSnapshot ? signerWallets : undefined,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveSignerWallets = liveSignerWalletsData ?? signerWallets;
  const signerWalletsLoading = isFeaturesStep && liveSignerWalletsData === undefined;
  const resolvedSignerWalletsError = liveSignerWalletsError
    ? liveSignerWalletsError instanceof Error
      ? liveSignerWalletsError.message
      : "Unable to load signer wallets."
    : liveSignerWalletsData === undefined
      ? signerWalletsError
      : null;
  const availableSignerWallets = liveSignerWallets.filter(
    (w) => w.walletId.trim() && w.publicKey.trim()
  );

  const canContinueFromIdentity =
    identityValidation.uriValid &&
    identityValidation.nameValid &&
    identityValidation.symbolValid &&
    identityValidation.decimalsValid;
  const selectedAccessControlAvailable =
    template && flow.kind === "creation"
      ? isAccessControlModeAvailable(template, draft.accessControlMode)
      : false;
  const canSubmit =
    flow.kind === "creation" &&
    canContinueFromIdentity &&
    selectedAccessControlAvailable &&
    !isPending;

  const updateDraft = (patch: Partial<TokenDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleTemplateSelect = (selected: TemplateSelection) => {
    setDraft((prev) => ({
      ...prev,
      template: selected,
      decimals: getTemplateDefaultDecimals(selected),
      accessControlMode: getDefaultAccessControlMode(selected),
    }));
    setFlow({ kind: "creation", template: selected, step: "identity" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleBackFromIdentity = () => {
    setFlow({ kind: "templateSelection" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleBackFromFeatures = () => {
    if (!template) return;
    setFlow({ kind: "creation", template, step: "identity" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleContinueFromIdentity = () => {
    if (!template || !canContinueFromIdentity) return;
    setFlow({ kind: "creation", template, step: "features" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleCreateToken = () => {
    if (!canSubmit || !template) return;

    const formData = new FormData();
    formData.set("template", template);
    formData.set("uri", draft.uri.trim());
    formData.set("name", draft.name.trim());
    formData.set("symbol", draft.symbol.trim());
    formData.set("decimals", draft.decimals);
    formData.set("requiresAllowlist", String(toRequiresAllowlist(draft.accessControlMode)));
    formData.set("enableConfidentialTransfers", String(enableConfidentialTransfers));
    if (draft.signingWalletId) {
      formData.set("signingWalletId", draft.signingWalletId);
    }

    const toastId = toast.loading("Creating draft token.", { position: "bottom-right" });

    startTransition(async () => {
      const response = await createIssuanceTokenAction(formData).catch((error) => ({
        state: "error" as const,
        message: error instanceof Error ? error.message : "Unable to create draft token.",
        tokenId: null,
        tokenName: null,
      }));
      setSubmitState(response);

      if (response.state === "success") {
        toast.success(
          response.message ?? "Draft created. Deploy it on-chain from the token page.",
          { id: toastId, position: "bottom-right" }
        );
        router.push("/dashboard/issuance");
        return;
      }

      toast.error(response.message ?? "Unable to create draft token.", {
        id: toastId,
        position: "bottom-right",
      });
    });
  };

  // ── Template selection step ──────────────────────────────────────────────

  if (flow.kind === "templateSelection") {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="text-center">
            <p className="text-[28px] leading-tight font-medium text-text-extra-high">
              Choose a template
            </p>
            <p className="mt-2 text-base text-text-low">
              Configure the draft now, then deploy it on-chain from the token page.
            </p>
          </div>

          <div className="space-y-3">
            {templateCards.map((card) => {
              const Icon = card.icon;
              if (!card.enabled || !card.template) {
                return (
                  <div
                    key={card.id}
                    aria-disabled
                    className="flex cursor-not-allowed items-center justify-between rounded-2xl border border-border-light bg-border-extra-light px-5 py-4 opacity-60"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <div
                        className={[
                          "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
                          card.iconClassName,
                        ].join(" ")}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-xl leading-none font-semibold text-text-extra-high">
                          {card.name}
                        </p>
                        <p className="mt-2 text-base text-text-low">{card.description}</p>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => handleTemplateSelect(card.template as TemplateSelection)}
                  className="flex w-full cursor-pointer items-center justify-between rounded-2xl border border-border-light bg-white px-5 py-4 text-left transition-colors hover:bg-border-extra-light"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <div
                      className={[
                        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
                        card.iconClassName,
                      ].join(" ")}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-xl leading-none font-semibold text-text-extra-high">
                        {card.name}
                      </p>
                      <p className="mt-2 text-base text-text-low">{card.description}</p>
                    </div>
                  </div>
                  <ChevronRight className="ml-3 h-5 w-5 shrink-0 text-text-extra-low" />
                </button>
              );
            })}
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row sm:justify-start">
          <Button type="button" variant="secondary" className="h-14 rounded-full text-base" asChild>
            <Link href="/dashboard/issuance">
              <ArrowLeft className="h-4 w-4" />
              Cancel
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  // ── Identity step ────────────────────────────────────────────────────────

  if (flow.kind === "creation" && flow.step === "identity" && template) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="text-center">
            <p className="text-[28px] leading-tight font-medium text-text-extra-high">
              Token details
            </p>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="issuance-token-uri">Metadata URI</Label>
              <Input
                id="issuance-token-uri"
                type="url"
                value={draft.uri}
                onChange={(e) => updateDraft({ uri: e.currentTarget.value })}
                placeholder="https://example.com/metadata.json"
                aria-invalid={draft.uri.length > 0 && !identityValidation.uriValid}
                className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="issuance-token-name">Token Name</Label>
              <Input
                id="issuance-token-name"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.currentTarget.value })}
                placeholder="e.g., USD Coin"
                className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="issuance-token-symbol">Symbol</Label>
              <Input
                id="issuance-token-symbol"
                value={draft.symbol}
                onChange={(e) => updateDraft({ symbol: normalizeSymbol(e.currentTarget.value) })}
                placeholder="e.g., USDC"
                className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="issuance-token-decimals">Decimals</Label>
              <Input
                id="issuance-token-decimals"
                type="number"
                min="0"
                max="18"
                step="1"
                inputMode="numeric"
                value={draft.decimals}
                onChange={(e) => updateDraft({ decimals: e.currentTarget.value })}
                placeholder="e.g., 6"
                aria-invalid={draft.decimals.length > 0 && !identityValidation.decimalsValid}
                className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
                required
              />
              {draft.decimals.length > 0 && !identityValidation.decimalsValid ? (
                <p className="text-sm text-status-error-text" role="alert">
                  Enter a whole number between 0 and 18.
                </p>
              ) : null}
              <p className="text-sm text-text-low">{getDecimalsHelperText(template)}</p>
            </div>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="secondary"
            className="h-14 rounded-full text-base"
            onClick={handleBackFromIdentity}
            iconLeft={<ArrowLeft className="h-4 w-4" />}
          >
            Previous
          </Button>
          <Button
            type="button"
            className="h-14 rounded-full text-base"
            disabled={!canContinueFromIdentity}
            onClick={handleContinueFromIdentity}
            iconRight={<ArrowRight className="h-4 w-4" />}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  // ── Features step ────────────────────────────────────────────────────────

  if (flow.kind === "creation" && flow.step === "features" && template) {
    const accessControlOptions = getAccessControlOptions(template);

    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="text-center">
            <p className="text-[28px] leading-tight font-medium text-text-extra-high">
              Configuration
            </p>
          </div>

          <div className="space-y-6">
            {/* Main signer */}
            <div className="space-y-2">
              <Label htmlFor="issuance-token-main-signer">Main signer</Label>
              {availableSignerWallets.length > 0 ? (
                <>
                  <select
                    id="issuance-token-main-signer"
                    name="signingWalletId"
                    value={draft.signingWalletId}
                    onChange={(e) => updateDraft({ signingWalletId: e.currentTarget.value })}
                    className="h-12 w-full rounded-2xl border border-border-light bg-white px-4 text-base text-text-extra-high shadow-none outline-none transition-[box-shadow,border-color] focus:border-border-mid focus:ring-2 focus:ring-border-light"
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
                  <p className="text-sm text-text-low">
                    This wallet will be used as the token&apos;s main signer for deploy and later
                    token actions.
                  </p>
                </>
              ) : signerWalletsLoading ? (
                <p className="rounded-2xl border border-border-light bg-border-extra-light px-4 py-3 text-sm text-text-low">
                  Loading signer wallets…
                </p>
              ) : resolvedSignerWalletsError ? (
                <p className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">
                  {resolvedSignerWalletsError}
                </p>
              ) : (
                <p className="rounded-2xl border border-border-light bg-border-extra-light px-4 py-3 text-sm text-text-low">
                  No controlled wallets are available yet. The token will use the current default
                  signer.
                </p>
              )}
            </div>

            {/* Transfer controls */}
            <div className="space-y-3">
              <div>
                <Label>Transfer controls</Label>
                <p className="mt-1 text-sm text-text-low">
                  Choose how this token should treat approved or blocked destination addresses.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {accessControlOptions.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => updateDraft({ accessControlMode: option.mode })}
                    className={[
                      "rounded-2xl border p-4 text-left transition-colors",
                      draft.accessControlMode === option.mode
                        ? "border-text-extra-high bg-border-extra-light"
                        : "border-border-light bg-white",
                      "cursor-pointer hover:bg-border-extra-light",
                    ].join(" ")}
                  >
                    {option.mode === "allowlist" ? (
                      <ShieldCheck className="h-5 w-5 text-text-extra-high" />
                    ) : (
                      <ShieldAlert className="h-5 w-5 text-text-extra-high" />
                    )}
                    <p className="mt-3 text-base font-semibold text-text-extra-high">
                      {option.title}
                    </p>
                    <p className="mt-1 text-sm text-text-low">{option.description}</p>
                    <p className="mt-1 text-xs text-text-extra-low">{option.note}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Confidential transfers (devnet only) */}
            {isDevnet ? (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setEnableConfidentialTransfers((v) => !v)}
                  className={[
                    "flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-colors",
                    enableConfidentialTransfers
                      ? "border-text-extra-high bg-border-extra-light"
                      : "border-border-light bg-white hover:bg-border-extra-light",
                  ].join(" ")}
                >
                  <EyeOff className="h-5 w-5 shrink-0 text-text-extra-high" />
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-text-extra-high">
                      Confidential transfers
                    </p>
                    <p className="mt-1 text-sm text-text-low">
                      Enable the Token-2022 confidential transfer extension. Balances and amounts
                      are hidden on-chain. Devnet only.
                    </p>
                  </div>
                  <span
                    aria-hidden
                    className={[
                      "ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
                      enableConfidentialTransfers
                        ? "border-text-extra-high bg-text-extra-high text-white"
                        : "border-border-mid bg-transparent",
                    ].join(" ")}
                  >
                    {enableConfidentialTransfers ? (
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    ) : null}
                  </span>
                </button>
              </div>
            ) : null}

            <AnimatePresence>
              {submitState.state === "error" && submitState.message ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text"
                >
                  {submitState.message}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="secondary"
            className="h-14 rounded-full text-base"
            onClick={handleBackFromFeatures}
            disabled={isPending}
            iconLeft={<ArrowLeft className="h-4 w-4" />}
          >
            Previous
          </Button>
          <Button
            type="button"
            className="h-14 rounded-full text-base"
            disabled={!canSubmit}
            onClick={handleCreateToken}
          >
            {isPending ? "Creating…" : getCreateButtonLabel(template)}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
