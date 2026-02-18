"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { type CreateIssuanceTokenResult, createIssuanceTokenAction } from "./actions";
import {
  type IssuanceTemplateId,
  getTemplateCatalogEntry,
  issuanceTemplateCatalog,
} from "./template-catalog";

type WizardStep = 0 | 1 | 2 | 3;

interface TokenDraft {
  template: IssuanceTemplateId;
  name: string;
  symbol: string;
  decimals: string;
  description: string;
  maxSupply: string;
  requiresAllowlist: boolean;
  isMintable: boolean;
  isFreezable: boolean;
}

function createInitialDraft(): TokenDraft {
  return {
    template: "stablecoin",
    name: "",
    symbol: "",
    decimals: "6",
    description: "",
    maxSupply: "",
    requiresAllowlist: false,
    isMintable: true,
    isFreezable: true,
  };
}

const wizardLabels = ["Template", "Token setup", "Review"] as const;

const INITIAL_CREATE_ISSUANCE_TOKEN_RESULT: CreateIssuanceTokenResult = {
  state: "idle",
  message: null,
  tokenId: null,
  tokenName: null,
};

function getProgressPercent(step: WizardStep): number {
  if (step === 3) {
    return 100;
  }
  return ((step + 1) / wizardLabels.length) * 100;
}

export function CreateIssuanceTokenModal() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>(0);
  const [draft, setDraft] = useState<TokenDraft>(createInitialDraft());
  const [submitState, setSubmitState] = useState<CreateIssuanceTokenResult>(
    INITIAL_CREATE_ISSUANCE_TOKEN_RESULT
  );
  const [isPending, startTransition] = useTransition();

  const selectedTemplate = useMemo(() => getTemplateCatalogEntry(draft.template), [draft.template]);

  const canContinueFromSetup =
    draft.name.trim().length > 0 && /^[A-Z0-9]{1,10}$/.test(draft.symbol);

  const open = () => {
    setIsOpen(true);
  };

  const close = () => {
    setIsOpen(false);
    setStep(0);
    setDraft(createInitialDraft());
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleTemplateSelect = (template: IssuanceTemplateId) => {
    const templateInfo = getTemplateCatalogEntry(template);
    setDraft((previous) => ({
      ...previous,
      template,
      decimals: String(templateInfo?.defaultDecimals ?? previous.decimals),
    }));
  };

  const handleCreateToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const response = await createIssuanceTokenAction(formData);
      setSubmitState(response);

      if (response.state === "success") {
        setStep(3);
        router.refresh();
      }
    });
  };

  return (
    <>
      <Button type="button" onClick={open}>
        Create token
      </Button>

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
              exit={{ y: 20, opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="relative z-10 w-full max-w-2xl rounded-3xl border border-[rgba(28,28,29,0.16)] bg-white p-6 shadow-[0_24px_64px_rgba(28,28,29,0.28)]"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[#1c1c1d]">
                    {step === 3 ? "Token created" : "Create token"}
                  </p>
                  <span className="text-xs text-[rgba(28,28,29,0.62)]">
                    {step === 3 ? "Completed" : `Step ${step + 1} of ${wizardLabels.length}`}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(28,28,29,0.08)] [direction:ltr]">
                  <motion.div
                    className="h-full w-full origin-left rounded-full bg-[#1c1c1d]"
                    initial={false}
                    animate={{ scaleX: getProgressPercent(step) / 100 }}
                    transition={{ duration: 0.28, ease: "easeInOut" }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-[rgba(28,28,29,0.62)]">
                  {wizardLabels.map((label, index) => (
                    <span
                      key={label}
                      className={
                        step === 3 || step >= index
                          ? "font-medium text-[#1c1c1d]"
                          : "text-[rgba(28,28,29,0.48)]"
                      }
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              <AnimatePresence mode="wait">
                {step === 0 ? (
                  <motion.div
                    key="template-step"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mt-6 space-y-4"
                  >
                    <div>
                      <p className="text-base font-medium text-[#1c1c1d]">
                        Choose a token template
                      </p>
                      <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
                        Templates apply sensible defaults similar to Mosaic flows, using SDP API
                        under the hood.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {issuanceTemplateCatalog.map((template) => {
                        const isSelected = draft.template === template.id;
                        return (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => handleTemplateSelect(template.id)}
                            className={[
                              "rounded-2xl border px-4 py-3 text-left transition-colors",
                              isSelected
                                ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)]"
                                : "border-[rgba(28,28,29,0.12)] hover:bg-[rgba(28,28,29,0.03)]",
                            ].join(" ")}
                          >
                            <p className="text-sm font-semibold text-[#1c1c1d]">{template.name}</p>
                            <p className="mt-1 text-xs text-[rgba(28,28,29,0.66)]">
                              {template.description}
                            </p>
                            <p className="mt-2 text-xs text-[rgba(28,28,29,0.58)]">
                              {template.helper}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-2">
                      <Button type="button" variant="secondary" onClick={close}>
                        Cancel
                      </Button>
                      <Button type="button" onClick={() => setStep(1)}>
                        Continue
                      </Button>
                    </div>
                  </motion.div>
                ) : null}

                {step === 1 ? (
                  <motion.div
                    key="setup-step"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mt-6 space-y-4"
                  >
                    <div>
                      <p className="text-base font-medium text-[#1c1c1d]">
                        Configure token settings
                      </p>
                      <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
                        Fill in core metadata. You can tune supply and controls before deployment.
                      </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="grid gap-2 sm:col-span-2">
                        <Label htmlFor="issuance-token-name">Token name</Label>
                        <Input
                          id="issuance-token-name"
                          value={draft.name}
                          onChange={(event) => {
                            const name = event.currentTarget.value;
                            setDraft((previous) => ({ ...previous, name }));
                          }}
                          placeholder="Acme Dollar"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="issuance-token-symbol">Symbol</Label>
                        <Input
                          id="issuance-token-symbol"
                          value={draft.symbol}
                          onChange={(event) => {
                            const symbol = event.currentTarget.value
                              .toUpperCase()
                              .replace(/[^A-Z0-9]/g, "")
                              .slice(0, 10);
                            setDraft((previous) => ({ ...previous, symbol }));
                          }}
                          placeholder="ACME"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="issuance-token-decimals">Decimals</Label>
                        <Input
                          id="issuance-token-decimals"
                          type="number"
                          min={0}
                          max={18}
                          value={draft.decimals}
                          onChange={(event) => {
                            const decimals = event.currentTarget.value;
                            setDraft((previous) => ({ ...previous, decimals }));
                          }}
                        />
                      </div>
                      <div className="grid gap-2 sm:col-span-2">
                        <Label htmlFor="issuance-token-description">Description (optional)</Label>
                        <Input
                          id="issuance-token-description"
                          value={draft.description}
                          onChange={(event) => {
                            const description = event.currentTarget.value;
                            setDraft((previous) => ({ ...previous, description }));
                          }}
                          placeholder="Asset-backed token for treasury operations"
                        />
                      </div>
                      <div className="grid gap-2 sm:col-span-2">
                        <Label htmlFor="issuance-token-max-supply">Max supply (optional)</Label>
                        <Input
                          id="issuance-token-max-supply"
                          value={draft.maxSupply}
                          onChange={(event) => {
                            const maxSupply = event.currentTarget.value;
                            setDraft((previous) => ({ ...previous, maxSupply }));
                          }}
                          placeholder="100000000"
                        />
                        <p className="text-xs text-[rgba(28,28,29,0.62)]">
                          Leave empty to keep supply uncapped.
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-2 rounded-2xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-3 text-sm">
                      <label className="flex items-center justify-between gap-3">
                        <span className="text-[rgba(28,28,29,0.78)]">Require allowlist</span>
                        <input
                          type="checkbox"
                          checked={draft.requiresAllowlist}
                          onChange={(event) => {
                            const requiresAllowlist = event.currentTarget.checked;
                            setDraft((previous) => ({ ...previous, requiresAllowlist }));
                          }}
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3">
                        <span className="text-[rgba(28,28,29,0.78)]">Token is mintable</span>
                        <input
                          type="checkbox"
                          checked={draft.isMintable}
                          onChange={(event) => {
                            const isMintable = event.currentTarget.checked;
                            setDraft((previous) => ({ ...previous, isMintable }));
                          }}
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3">
                        <span className="text-[rgba(28,28,29,0.78)]">Token is freezable</span>
                        <input
                          type="checkbox"
                          checked={draft.isFreezable}
                          onChange={(event) => {
                            const isFreezable = event.currentTarget.checked;
                            setDraft((previous) => ({ ...previous, isFreezable }));
                          }}
                        />
                      </label>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-2">
                      <Button type="button" variant="secondary" onClick={() => setStep(0)}>
                        Back
                      </Button>
                      <Button
                        type="button"
                        disabled={!canContinueFromSetup}
                        onClick={() => setStep(2)}
                      >
                        Review
                      </Button>
                    </div>
                  </motion.div>
                ) : null}

                {step === 2 ? (
                  <motion.form
                    key="review-step"
                    onSubmit={handleCreateToken}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mt-6 space-y-4"
                  >
                    <input type="hidden" name="template" value={draft.template} />
                    <input type="hidden" name="name" value={draft.name} />
                    <input type="hidden" name="symbol" value={draft.symbol} />
                    <input type="hidden" name="decimals" value={draft.decimals} />
                    <input type="hidden" name="description" value={draft.description} />
                    <input type="hidden" name="maxSupply" value={draft.maxSupply} />
                    <input
                      type="hidden"
                      name="requiresAllowlist"
                      value={String(draft.requiresAllowlist)}
                    />
                    <input type="hidden" name="isMintable" value={String(draft.isMintable)} />
                    <input type="hidden" name="isFreezable" value={String(draft.isFreezable)} />

                    <div>
                      <p className="text-base font-medium text-[#1c1c1d]">Review request</p>
                      <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
                        We will submit this token creation request to SDP issuance API.
                      </p>
                    </div>

                    <div className="grid gap-2 rounded-2xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-4 text-sm text-[rgba(28,28,29,0.78)]">
                      <div className="flex items-center justify-between gap-2">
                        <span>Template</span>
                        <span className="font-medium text-[#1c1c1d]">
                          {selectedTemplate?.name ?? draft.template}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>Name</span>
                        <span className="font-medium text-[#1c1c1d]">{draft.name}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>Symbol</span>
                        <span className="font-medium text-[#1c1c1d]">{draft.symbol}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>Decimals</span>
                        <span className="font-medium text-[#1c1c1d]">{draft.decimals || "0"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>Max supply</span>
                        <span className="font-medium text-[#1c1c1d]">
                          {draft.maxSupply || "Uncapped"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>Allowlist</span>
                        <span className="font-medium text-[#1c1c1d]">
                          {draft.requiresAllowlist ? "Required" : "Optional"}
                        </span>
                      </div>
                    </div>

                    {submitState.state === "error" && submitState.message ? (
                      <div className="rounded-xl border border-[#c71f37]/30 bg-[#c71f37]/6 px-3 py-2 text-sm text-[#8a1f2a]">
                        {submitState.message}
                      </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-2 pt-2">
                      <Button type="button" variant="secondary" onClick={() => setStep(1)}>
                        Back
                      </Button>
                      <Button type="submit" disabled={isPending}>
                        {isPending ? "Creating..." : "Create token"}
                      </Button>
                    </div>
                  </motion.form>
                ) : null}

                {step === 3 ? (
                  <motion.div
                    key="success-step"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mt-6 space-y-5"
                  >
                    <motion.div
                      initial={{ scale: 0.85, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.28, ease: "easeOut" }}
                      className="flex flex-col items-center rounded-2xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 py-8 text-center"
                    >
                      <motion.div
                        animate={{ scale: [0.8, 1.06, 1], rotate: [-10, 6, 0] }}
                        transition={{ duration: 0.52, ease: "easeOut" }}
                      >
                        <CheckCircle2 className="h-12 w-12 text-[#1c1c1d]" />
                      </motion.div>
                      <h3 className="mt-4 text-xl font-semibold text-[#1c1c1d]">
                        Token created successfully
                      </h3>
                      <p className="mt-2 text-sm text-[rgba(28,28,29,0.72)]">
                        {submitState.tokenName
                          ? `${submitState.tokenName} is now available in your token list.`
                          : "Your token is now available in your token list."}
                      </p>
                      {submitState.tokenId ? (
                        <p className="mt-2 font-mono text-xs text-[rgba(28,28,29,0.64)]">
                          {submitState.tokenId}
                        </p>
                      ) : null}
                    </motion.div>

                    <div className="flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          setStep(0);
                          setDraft(createInitialDraft());
                          setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
                        }}
                      >
                        <Sparkles className="h-4 w-4" />
                        Create another
                      </Button>
                      <Button type="button" onClick={close}>
                        Done
                      </Button>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
