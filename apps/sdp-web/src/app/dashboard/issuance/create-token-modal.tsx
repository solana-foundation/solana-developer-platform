"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AnimatePresence, motion } from "framer-motion";
import {
  BadgeDollarSign,
  ChevronRight,
  CircleHelp,
  Gamepad2,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { type CreateIssuanceTokenResult, createIssuanceTokenAction } from "./actions";

type TemplateSelection = "stablecoin" | "custom" | "tokenized-security" | "arcade";
type CreationStep = "identity" | "features";
type AccessControlMode = "allowlist" | "blocklist";

type FlowState =
  | {
      kind: "templateSelection";
    }
  | {
      kind: "creation";
      template: TemplateSelection;
      step: CreationStep;
    };

interface TokenDraft {
  template: TemplateSelection | null;
  uri: string;
  name: string;
  symbol: string;
  decimals: "" | "0" | "6" | "8" | "9";
  accessControlMode: AccessControlMode;
}

interface TemplateCardDescriptor {
  id: string;
  name: string;
  description: string;
  icon: typeof BadgeDollarSign;
  iconClassName: string;
  enabled: boolean;
  template?: TemplateSelection;
}

const templateCards: TemplateCardDescriptor[] = [
  {
    id: "stablecoin",
    name: "Stablecoin",
    description: "Create a regulatory-compliant stablecoin with transfer restrictions.",
    icon: BadgeDollarSign,
    iconClassName: "bg-[#dee6ff] text-[#375dff]",
    enabled: true,
    template: "stablecoin",
  },
  {
    id: "tokenized-security",
    name: "Tokenized Security",
    description: "Create a compliant security token with scaled UI amounts and core controls.",
    icon: ShieldCheck,
    iconClassName: "bg-[#d8f7e4] text-[#0f9b58]",
    enabled: true,
    template: "tokenized-security",
  },
  {
    id: "arcade",
    name: "Arcade Token",
    description: "Deploy a gaming or utility token with custom extensions and features.",
    icon: Gamepad2,
    iconClassName: "bg-[#f7ead8] text-[#ff6b00]",
    enabled: true,
    template: "arcade",
  },
  {
    id: "custom",
    name: "Custom Token",
    description: "Build your own token with full control over extensions and parameters.",
    icon: CircleHelp,
    iconClassName: "bg-[#ebe5ff] text-[#6436ff]",
    enabled: true,
    template: "custom",
  },
];

const INITIAL_CREATE_ISSUANCE_TOKEN_RESULT: CreateIssuanceTokenResult = {
  state: "idle",
  message: null,
  tokenId: null,
  tokenName: null,
};

function createInitialDraft(): TokenDraft {
  return {
    template: null,
    uri: "",
    name: "",
    symbol: "",
    decimals: "",
    accessControlMode: "blocklist",
  };
}

function getTemplateTitle(template: TemplateSelection): string {
  switch (template) {
    case "stablecoin":
      return "Create a Stablecoin";
    case "custom":
      return "Create Custom Token";
    case "tokenized-security":
      return "Create Tokenized Security";
    case "arcade":
      return "Create Arcade Token";
    default:
      return "Create Token";
  }
}

function getCreateButtonLabel(template: TemplateSelection): string {
  switch (template) {
    case "stablecoin":
      return "Create Stablecoin";
    case "custom":
      return "Create Custom Token";
    case "tokenized-security":
      return "Create Tokenized Security";
    case "arcade":
      return "Create Arcade Token";
    default:
      return "Create Token";
  }
}

function getTemplateDefaultDecimals(template: TemplateSelection): TokenDraft["decimals"] {
  switch (template) {
    case "stablecoin":
      return "6";
    case "custom":
      return "9";
    case "tokenized-security":
      return "8";
    case "arcade":
      return "0";
    default:
      return "6";
  }
}

function getTemplateDecimalOptions(
  template: TemplateSelection
): ReadonlyArray<TokenDraft["decimals"]> {
  switch (template) {
    case "stablecoin":
    case "custom":
      return ["6", "9"];
    case "tokenized-security":
      return ["8"];
    case "arcade":
      return ["0", "6"];
    default:
      return ["6", "9"];
  }
}

function getDefaultAccessControlMode(template: TemplateSelection): AccessControlMode {
  return template === "tokenized-security" ? "allowlist" : "blocklist";
}

function getAccessControlAvailability(
  template: TemplateSelection,
  mode: AccessControlMode
): {
  available: boolean;
  note: string;
} {
  if (template === "tokenized-security") {
    if (mode === "allowlist") {
      return {
        available: true,
        note: "Required for Tokenized Security in current API flow.",
      };
    }
    return {
      available: false,
      note: "Tokenized Security requires allowlist mode in current API flow.",
    };
  }

  return {
    available: true,
    note: "Available for this template in current API flow.",
  };
}

function toRequiresAllowlist(template: TemplateSelection, mode: AccessControlMode): boolean {
  if (template === "tokenized-security") {
    return true;
  }
  return mode === "allowlist";
}

function isValidMetadataUri(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "")
    .slice(0, 10);
}

function TemplateCard({
  descriptor,
  onSelect,
}: {
  descriptor: TemplateCardDescriptor;
  onSelect: (template: TemplateSelection) => void;
}) {
  const Icon = descriptor.icon;

  if (!descriptor.enabled || !descriptor.template) {
    return (
      <div
        aria-disabled
        className="cursor-not-allowed flex items-center justify-between rounded-2xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-5 py-4 opacity-70"
      >
        <div className="flex min-w-0 items-center gap-4">
          <div
            className={[
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
              descriptor.iconClassName,
            ].join(" ")}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xl leading-none font-semibold text-[#1c1c1d]">{descriptor.name}</p>
            <p className="mt-2 text-base text-[rgba(28,28,29,0.58)]">{descriptor.description}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(descriptor.template as TemplateSelection)}
      className="cursor-pointer flex w-full items-center justify-between rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white px-5 py-4 text-left transition-colors hover:bg-[rgba(28,28,29,0.03)]"
    >
      <div className="flex min-w-0 items-center gap-4">
        <div
          className={[
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
            descriptor.iconClassName,
          ].join(" ")}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xl leading-none font-semibold text-[#1c1c1d]">{descriptor.name}</p>
          <p className="mt-2 text-base text-[rgba(28,28,29,0.66)]">{descriptor.description}</p>
        </div>
      </div>
      <ChevronRight className="ml-3 h-5 w-5 shrink-0 text-[rgba(28,28,29,0.56)]" />
    </button>
  );
}

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

  const setIsOpen = (next: boolean) => {
    if (open === undefined) {
      setIsOpenInternal(next);
    }
    onOpenChange?.(next);
  };

  const template = flow.kind === "creation" ? flow.template : draft.template;
  const decimalOptions = useMemo(
    () => (template ? getTemplateDecimalOptions(template) : []),
    [template]
  );

  const identityValidation = useMemo(() => {
    const uri = draft.uri.trim();
    const name = draft.name.trim();
    const symbol = draft.symbol.trim();

    const uriValid = isValidMetadataUri(uri);
    const nameValid = name.length > 0 && name.length <= 100;
    const symbolValid = /^[A-Z0-9.]{1,10}$/.test(symbol);
    const decimalsValid =
      template !== null && getTemplateDecimalOptions(template).includes(draft.decimals);

    return {
      uriValid,
      nameValid,
      symbolValid,
      decimalsValid,
      isValid: uriValid && nameValid && symbolValid && decimalsValid,
    };
  }, [draft.uri, draft.name, draft.symbol, draft.decimals, template]);

  const isIdentityStep = flow.kind === "creation" && flow.step === "identity";
  const isFeaturesStep = flow.kind === "creation" && flow.step === "features";
  const selectedAccessControlAvailable =
    template && flow.kind === "creation"
      ? getAccessControlAvailability(template, draft.accessControlMode).available
      : false;

  const canContinueFromIdentity = identityValidation.isValid;
  const canSubmit =
    flow.kind === "creation" &&
    identityValidation.isValid &&
    selectedAccessControlAvailable &&
    !isPending;

  const reset = () => {
    setFlow({ kind: "templateSelection" });
    setDraft(createInitialDraft());
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const close = () => {
    setIsOpen(false);
    reset();
  };

  const handleTemplateSelect = (selectedTemplate: TemplateSelection) => {
    setDraft((previous) => ({
      ...previous,
      template: selectedTemplate,
      decimals: getTemplateDefaultDecimals(selectedTemplate),
      accessControlMode: getDefaultAccessControlMode(selectedTemplate),
    }));
    setFlow({ kind: "creation", template: selectedTemplate, step: "identity" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleBackFromIdentity = () => {
    setFlow({ kind: "templateSelection" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleBackFromFeatures = () => {
    if (!template) {
      return;
    }
    setFlow({ kind: "creation", template, step: "identity" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
  };

  const handleContinueFromIdentity = () => {
    if (!template || !canContinueFromIdentity) {
      return;
    }
    setFlow({ kind: "creation", template, step: "features" });
    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
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
                  <motion.div
                    key="template-selection"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="px-6 py-6"
                  >
                    <div className="space-y-3">
                      {templateCards.map((card) => (
                        <TemplateCard
                          key={card.id}
                          descriptor={card}
                          onSelect={handleTemplateSelect}
                        />
                      ))}
                    </div>
                  </motion.div>
                ) : null}

                {isIdentityStep && template ? (
                  <motion.div
                    key="identity-step"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="px-6 pb-6"
                  >
                    <div className="space-y-5 rounded-[28px] bg-white p-5">
                      <p className="text-sm text-[rgba(28,28,29,0.62)]">
                        Fields marked * are required.
                      </p>

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
                            onChange={(event) => {
                              const uri = event.currentTarget.value;
                              setDraft((previous) => ({ ...previous, uri }));
                              setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
                            }}
                            placeholder="https://example.com/metadata.json"
                            aria-invalid={draft.uri.length > 0 && !identityValidation.uriValid}
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
                            onChange={(event) => {
                              const name = event.currentTarget.value;
                              setDraft((previous) => ({ ...previous, name }));
                              setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
                            }}
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
                            onChange={(event) => {
                              const symbol = normalizeSymbol(event.currentTarget.value);
                              setDraft((previous) => ({ ...previous, symbol }));
                              setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
                            }}
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
                                  onClick={() => {
                                    setDraft((previous) => ({ ...previous, decimals: value }));
                                    setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
                                  }}
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
                    </div>

                    <div className="mt-5 flex items-center justify-between gap-3">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleBackFromIdentity}
                        className="flex-1"
                      >
                        Back
                      </Button>
                      <Button
                        type="button"
                        onClick={handleContinueFromIdentity}
                        disabled={!canContinueFromIdentity}
                        className="flex-1"
                      >
                        Continue
                      </Button>
                    </div>
                  </motion.div>
                ) : null}

                {isFeaturesStep && template ? (
                  <motion.form
                    key="features-step"
                    onSubmit={handleCreateToken}
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
                        {(() => {
                          const allowlistAvailability = getAccessControlAvailability(
                            template,
                            "allowlist"
                          );
                          return (
                            <button
                              type="button"
                              onClick={() => {
                                if (!allowlistAvailability.available) {
                                  return;
                                }
                                setDraft((previous) => ({
                                  ...previous,
                                  accessControlMode: "allowlist",
                                }));
                                setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
                              }}
                              aria-disabled={!allowlistAvailability.available}
                              className={[
                                "rounded-3xl border p-5 text-left transition-colors",
                                draft.accessControlMode === "allowlist"
                                  ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)]"
                                  : "border-[rgba(28,28,29,0.14)] bg-white",
                                allowlistAvailability.available
                                  ? "cursor-pointer hover:bg-[rgba(28,28,29,0.03)]"
                                  : "cursor-not-allowed opacity-60",
                              ].join(" ")}
                            >
                              <ShieldCheck className="h-6 w-6 text-[#1c1c1d]" />
                              <p className="mt-4 text-2xl font-semibold text-[#1c1c1d]">
                                Allowlist
                              </p>
                              <p className="mt-2 text-base text-[rgba(28,28,29,0.66)]">
                                Only approved addresses can transfer
                              </p>
                              <p className="mt-2 text-sm text-[rgba(28,28,29,0.58)]">
                                {allowlistAvailability.note}
                              </p>
                            </button>
                          );
                        })()}

                        {(() => {
                          const blocklistAvailability = getAccessControlAvailability(
                            template,
                            "blocklist"
                          );
                          return (
                            <button
                              type="button"
                              onClick={() => {
                                if (!blocklistAvailability.available) {
                                  return;
                                }
                                setDraft((previous) => ({
                                  ...previous,
                                  accessControlMode: "blocklist",
                                }));
                                setSubmitState(INITIAL_CREATE_ISSUANCE_TOKEN_RESULT);
                              }}
                              aria-disabled={!blocklistAvailability.available}
                              className={[
                                "rounded-3xl border p-5 text-left transition-colors",
                                draft.accessControlMode === "blocklist"
                                  ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)]"
                                  : "border-[rgba(28,28,29,0.14)] bg-white",
                                blocklistAvailability.available
                                  ? "cursor-pointer hover:bg-[rgba(28,28,29,0.03)]"
                                  : "cursor-not-allowed opacity-60",
                              ].join(" ")}
                            >
                              <ShieldAlert className="h-6 w-6 text-[#1c1c1d]" />
                              <p className="mt-4 text-2xl font-semibold text-[#1c1c1d]">
                                Blocklist
                              </p>
                              <p className="mt-2 text-base text-[rgba(28,28,29,0.66)]">
                                Block specific addresses from transfers
                              </p>
                              <p className="mt-2 text-sm text-[rgba(28,28,29,0.58)]">
                                {blocklistAvailability.note}
                              </p>
                            </button>
                          );
                        })()}
                      </div>
                    </div>

                    {submitState.state === "error" && submitState.message ? (
                      <div className="mt-4 rounded-2xl border border-[#c71f37]/30 bg-[#c71f37]/6 px-4 py-3 text-base text-[#8a1f2a]">
                        {submitState.message}
                      </div>
                    ) : null}

                    <div className="mt-5 flex items-center justify-between gap-3">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleBackFromFeatures}
                        className="flex-1"
                      >
                        Back
                      </Button>
                      <Button type="submit" disabled={!canSubmit} className="flex-1">
                        {isPending ? "Creating..." : getCreateButtonLabel(template)}
                      </Button>
                    </div>
                  </motion.form>
                ) : null}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
