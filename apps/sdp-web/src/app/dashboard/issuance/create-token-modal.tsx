"use client";

import { Button } from "@/components/ui/button";
import { useEscapeKey } from "@/lib/use-escape-key";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { toast } from "sonner";
import { type CreateIssuanceTokenResult, createIssuanceTokenAction } from "./actions";
import { CreateTokenFeaturesStep } from "./create-token-features-step";
import { CreateTokenIdentityStep } from "./create-token-identity-step";
import type { FlowState, TemplateSelection, TokenDraft } from "./create-token-modal.types";
import {
  INITIAL_CREATE_ISSUANCE_TOKEN_RESULT,
  createInitialDraft,
  getAccessControlAvailability,
  getDefaultAccessControlMode,
  getTemplateDecimalOptions,
  getTemplateDefaultDecimals,
  getTemplateTitle,
  isValidMetadataUri,
} from "./create-token-modal.utils";
import { TemplateSelectionStep } from "./create-token-template-selection-step";

interface CreateIssuanceTokenModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  triggerLabel?: string;
  triggerClassName?: string;
}

export function CreateIssuanceTokenModal({
  open,
  onOpenChange,
  hideTrigger = false,
  triggerLabel = "Create token",
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
  const decimalOptions = template ? getTemplateDecimalOptions(template) : [];
  const uri = draft.uri.trim();
  const name = draft.name.trim();
  const symbol = draft.symbol.trim();
  const identityValidation = {
    uriValid: isValidMetadataUri(uri),
    nameValid: name.length > 0 && name.length <= 100,
    symbolValid: /^[A-Z0-9.]{1,10}$/.test(symbol),
    decimalsValid:
      template !== null && getTemplateDecimalOptions(template).includes(draft.decimals),
  };
  const isIdentityStep = flow.kind === "creation" && flow.step === "identity";
  const isFeaturesStep = flow.kind === "creation" && flow.step === "features";
  const selectedAccessControlAvailable =
    template && flow.kind === "creation"
      ? getAccessControlAvailability(template, draft.accessControlMode).available
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
        toast.success(response.message ?? "Token created successfully.");
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
                    {template ? getTemplateTitle(template) : "Create New Token"}
                  </p>
                  <p className="mt-2 text-lg text-[rgba(28,28,29,0.62)]">
                    {template ? "Configure your token parameters" : "Choose how you want to start."}
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
                    decimalOptions={decimalOptions}
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
                    submitState={submitState}
                    isPending={isPending}
                    canSubmit={canSubmit}
                    onAccessControlModeChange={(mode) =>
                      updateDraft({
                        accessControlMode: mode,
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
