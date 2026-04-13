"use client";

import { Button } from "@/components/ui/button";
import { useEscapeKey } from "@/lib/use-escape-key";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { fetchWallets } from "../payments/payments-workspace.data";
import { type CreateIssuanceTokenResult, createIssuanceTokenAction } from "./actions";
import { CreateTokenFeaturesStep } from "./create-token-features-step";
import { CreateTokenIdentityStep } from "./create-token-identity-step";
import type { FlowState, TemplateSelection, TokenDraft } from "./create-token-modal.types";
import {
  INITIAL_CREATE_ISSUANCE_TOKEN_RESULT,
  createInitialDraft,
  getDefaultAccessControlMode,
  getTemplateDefaultDecimals,
  getTemplateTitle,
  isAccessControlModeAvailable,
  isValidMetadataUri,
  isValidTokenDecimals,
  isValidTokenSymbol,
} from "./create-token-modal.utils";
import { TemplateSelectionStep } from "./create-token-template-selection-step";

interface CreateIssuanceTokenModalProps {
  signerWallets?: PaymentsDashboardWallet[];
  signerWalletsError?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  triggerLabel?: string;
  triggerClassName?: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: modal flow intentionally coordinates multi-step issuance creation in one component.
export function CreateIssuanceTokenModal({
  signerWallets = [],
  signerWalletsError = null,
  open,
  onOpenChange,
  hideTrigger = false,
  triggerLabel = "Create draft",
  triggerClassName,
}: CreateIssuanceTokenModalProps = {}) {
  const router = useRouter();
  const [isOpenInternal, setIsOpenInternal] = useState(false);
  const [flow, setFlow] = useState<FlowState>({ kind: "templateSelection" });
  const [draft, setDraft] = useState<TokenDraft>(createInitialDraft());
  const [submitState, setSubmitState] = useState<CreateIssuanceTokenResult>(
    INITIAL_CREATE_ISSUANCE_TOKEN_RESULT
  );
  const [isPending, startTransition] = useTransition();
  const isOpen = open ?? isOpenInternal;

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
  const isIdentityStep = flow.kind === "creation" && flow.step === "identity";
  const isFeaturesStep = flow.kind === "creation" && flow.step === "features";
  const shouldLoadSignerWallets = isOpen && isFeaturesStep;
  const hasServerWalletSnapshot = signerWallets.length > 0 || signerWalletsError !== null;
  const { data: liveSignerWalletsData, error: liveSignerWalletsError } = useSWR(
    shouldLoadSignerWallets ? "issuance-create-token-signer-wallets" : null,
    () => fetchWallets(),
    {
      fallbackData: hasServerWalletSnapshot ? signerWallets : undefined,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveSignerWallets = liveSignerWalletsData ?? signerWallets;
  const signerWalletsLoading = shouldLoadSignerWallets && liveSignerWalletsData === undefined;
  const resolvedSignerWalletsError = liveSignerWalletsError
    ? liveSignerWalletsError instanceof Error
      ? liveSignerWalletsError.message
      : "Unable to load signer wallets."
    : liveSignerWalletsData === undefined
      ? signerWalletsError
      : null;
  const selectedAccessControlAvailable =
    template && flow.kind === "creation"
      ? isAccessControlModeAvailable(template, draft.accessControlMode)
      : false;
  const canContinueFromIdentity =
    identityValidation.uriValid &&
    identityValidation.nameValid &&
    identityValidation.symbolValid &&
    identityValidation.decimalsValid;
  const canSubmit =
    flow.kind === "creation" &&
    canContinueFromIdentity &&
    selectedAccessControlAvailable &&
    !isPending;

  const setIsOpen = (next: boolean) => {
    if (open === undefined) {
      setIsOpenInternal(next);
    }
    onOpenChange?.(next);
  };

  const resetSubmitState = () => {
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const updateDraft = (patch: Partial<TokenDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    resetSubmitState();
  };

  const reset = () => {
    setFlow({ kind: "templateSelection" });
    setDraft(createInitialDraft());
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const close = () => {
    setIsOpen(false);
    reset();
  };

  useEscapeKey(isOpen, close);

  const handleTemplateSelect = (selectedTemplate: TemplateSelection) => {
    setDraft((previous) => ({
      ...previous,
      template: selectedTemplate,
      decimals: getTemplateDefaultDecimals(selectedTemplate),
      accessControlMode: getDefaultAccessControlMode(selectedTemplate),
    }));
    setFlow({ kind: "creation", template: selectedTemplate, step: "identity" });
    resetSubmitState();
  };

  const handleBackFromIdentity = () => {
    setFlow({ kind: "templateSelection" });
    resetSubmitState();
  };

  const handleBackFromFeatures = () => {
    if (!template) {
      return;
    }
    setFlow({ kind: "creation", template, step: "identity" });
    resetSubmitState();
  };

  const handleContinueFromIdentity = () => {
    if (!template || !canContinueFromIdentity) {
      return;
    }
    setFlow({ kind: "creation", template, step: "features" });
    resetSubmitState();
  };

  const handleCreateToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!canSubmit || !template) {
      return;
    }

    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const response = await createIssuanceTokenAction(formData);
      setSubmitState(response);

      if (response.state === "success") {
        toast.success(response.message ?? "Draft created. Deploy it on-chain from the token page.");
        close();
        router.refresh();
      }
    });
  };

  return (
    <>
      {hideTrigger ? null : (
        <Button type="button" className={triggerClassName} onClick={() => setIsOpen(true)}>
          {triggerLabel}
        </Button>
      )}

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <button
              type="button"
              aria-label="Close token creation modal"
              className="absolute inset-0 bg-black/35"
              onClick={close}
            />

            <motion.div
              initial={{ y: 24, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 18, opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="relative z-10 w-full max-w-2xl overflow-hidden rounded-3xl border border-[rgba(28,28,29,0.16)] bg-white text-[#1c1c1d] shadow-[0_24px_64px_rgba(28,28,29,0.28)]"
            >
              <div className="flex items-start justify-between border-b border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] px-8 py-7">
                <div>
                  <p className="text-4xl leading-none font-semibold">
                    {template ? getTemplateTitle(template) : "Create New Token Draft"}
                  </p>
                  <p className="mt-2 text-lg text-[rgba(28,28,29,0.62)]">
                    {template
                      ? "Configure the draft now, then deploy it on-chain from the token page."
                      : "Choose a template to create a draft first, then deploy it on-chain."}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Close token creation modal"
                  onClick={close}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[rgba(28,28,29,0.08)] text-[rgba(28,28,29,0.72)] transition-colors hover:bg-[rgba(28,28,29,0.14)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <AnimatePresence mode="wait">
                {flow.kind === "templateSelection" ? (
                  <TemplateSelectionStep onSelect={handleTemplateSelect} />
                ) : null}

                {isIdentityStep && template ? (
                  <CreateTokenIdentityStep
                    template={template}
                    draft={draft}
                    validation={{
                      ...identityValidation,
                      isValid: canContinueFromIdentity,
                    }}
                    canContinue={canContinueFromIdentity}
                    onDraftChange={updateDraft}
                    onBack={handleBackFromIdentity}
                    onContinue={handleContinueFromIdentity}
                  />
                ) : null}

                {isFeaturesStep && template ? (
                  <CreateTokenFeaturesStep
                    template={template}
                    draft={draft}
                    signerWallets={liveSignerWallets}
                    signerWalletsLoading={signerWalletsLoading}
                    signerWalletsError={resolvedSignerWalletsError}
                    submitState={submitState}
                    isPending={isPending}
                    canSubmit={canSubmit}
                    onAccessControlModeChange={(mode) =>
                      updateDraft({
                        accessControlMode: mode,
                      })
                    }
                    onSigningWalletChange={(signingWalletId) =>
                      updateDraft({
                        signingWalletId,
                      })
                    }
                    onBack={handleBackFromFeatures}
                    onSubmit={handleCreateToken}
                  />
                ) : null}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
