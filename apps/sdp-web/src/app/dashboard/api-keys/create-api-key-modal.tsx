"use client";

import type { PaymentsDashboardWallet, SdpEnvironment } from "@sdp/types";
import { Info, KeyRound, type LucideIcon, Plus, ShieldCheck, Wallet } from "lucide-react";
import { type Dispatch, type ReactNode, type SetStateAction, useState } from "react";
import { useFormStatus } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { createApiKeyAction } from "./actions";

type ApiKeyRole = "api_admin" | "api_developer" | "api_readonly";
type WalletScope = "all" | "selected";

interface ApiKeyDraft {
  name: string;
  role: ApiKeyRole;
  expiresAt: string;
  walletScope: WalletScope;
  selectedWalletIds: string[];
  defaultWalletId: string;
}

function normalizeDraft(): ApiKeyDraft {
  return {
    name: "",
    role: "api_developer",
    expiresAt: "",
    walletScope: "all",
    selectedWalletIds: [],
    defaultWalletId: "",
  };
}

function formatEnvironmentLabel(environment: SdpEnvironment): string {
  return environment === "production" ? "Production" : "Sandbox";
}

function formatDisplayDate(value: string): string {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleString();
}

function formatWalletLabel(wallet: PaymentsDashboardWallet): string {
  return wallet.label?.trim() || wallet.walletId;
}

function formatRoleLabel(role: ApiKeyRole): string {
  if (role === "api_admin") return "Admin";
  if (role === "api_readonly") return "Read only";
  return "Developer";
}

function truncateAddress(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function PolicyScopeBadge() {
  return (
    <Badge variant="default" className="shrink-0 whitespace-nowrap text-[10px]">
      No API-key policy
    </Badge>
  );
}

function ReviewDetail({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3.5">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.64)]">
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-[rgba(28,28,29,0.56)]">{label}</p>
        <div className="mt-1 text-sm text-[#1c1c1d]">{children}</div>
      </div>
    </div>
  );
}

interface CreateApiKeyModalProps {
  wallets: PaymentsDashboardWallet[];
  triggerMode?: "button" | "icon";
  triggerLabel?: string;
  triggerVariant?: "default" | "secondary";
}

function resolveDefaultSelectedWallet(
  selectedWallets: PaymentsDashboardWallet[],
  defaultWalletId: string
): PaymentsDashboardWallet | null {
  return (
    selectedWallets.find((wallet) => wallet.walletId === defaultWalletId) ??
    selectedWallets[0] ??
    null
  );
}

function WalletAccessSection({
  draft,
  wallets,
  selectedWallets,
  setDraft,
  toggleWallet,
}: {
  draft: ApiKeyDraft;
  wallets: PaymentsDashboardWallet[];
  selectedWallets: PaymentsDashboardWallet[];
  setDraft: Dispatch<SetStateAction<ApiKeyDraft>>;
  toggleWallet: (walletId: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <div>
        <Label>Wallet access</Label>
        <p className="mt-1 text-xs text-[rgba(28,28,29,0.65)]">
          Choose whether this key can use every wallet in scope or only selected wallets.
        </p>
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-[rgba(28,28,29,0.14)] p-3">
        <input
          type="radio"
          name="wallet-access"
          value="all"
          checked={draft.walletScope === "all"}
          onChange={() => setDraft((previous) => ({ ...previous, walletScope: "all" }))}
          className="mt-1"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[#1c1c1d]">All wallets</p>
          <p className="text-xs text-[rgba(28,28,29,0.65)]">
            This key can use every wallet available in its org or project scope.
          </p>
          {draft.walletScope === "all" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[rgba(28,28,29,0.68)]">
              <ShieldCheck className="size-3.5" />
              <span>Operation policy</span>
              <PolicyScopeBadge />
            </div>
          ) : null}
        </div>
      </label>

      <label className="flex items-start gap-3 rounded-lg border border-[rgba(28,28,29,0.14)] p-3">
        <input
          type="radio"
          name="wallet-access"
          value="selected"
          checked={draft.walletScope === "selected"}
          onChange={() => setDraft((previous) => ({ ...previous, walletScope: "selected" }))}
          className="mt-1"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[#1c1c1d]">Selected wallets</p>
          <p className="text-xs text-[rgba(28,28,29,0.65)]">
            Restrict this key to a specific wallet set and choose its default signing wallet.
          </p>
        </div>
      </label>

      {draft.walletScope === "selected" ? (
        <div className="rounded-lg border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.02)] p-3">
          {wallets.length === 0 ? (
            <p className="text-sm text-[rgba(28,28,29,0.72)]">
              No active wallets are available for binding yet.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {wallets.map((wallet) => {
                  const checked = draft.selectedWalletIds.includes(wallet.walletId);

                  return (
                    <label
                      key={wallet.walletId}
                      className="flex items-start gap-3 rounded-lg border border-[rgba(28,28,29,0.12)] bg-white px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleWallet(wallet.walletId)}
                        className="mt-1"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[#1c1c1d]">
                          {formatWalletLabel(wallet)}
                        </p>
                        <p className="text-xs text-[rgba(28,28,29,0.65)]">
                          {wallet.walletId} · {truncateAddress(wallet.publicKey)}
                        </p>
                        {checked ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] px-2 py-1.5 text-xs text-[rgba(28,28,29,0.68)]">
                            <ShieldCheck className="size-3.5" />
                            <span>Operation policy</span>
                            <PolicyScopeBadge />
                          </div>
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>

              {draft.selectedWalletIds.length > 1 ? (
                <div className="grid gap-2">
                  <Label htmlFor="create-key-default-wallet">Default signing wallet</Label>
                  <select
                    id="create-key-default-wallet"
                    value={draft.defaultWalletId}
                    onChange={(event) => {
                      const defaultWalletId = event.currentTarget.value;
                      setDraft((previous) => ({ ...previous, defaultWalletId }));
                    }}
                    className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                  >
                    {selectedWallets.map((wallet) => (
                      <option key={wallet.walletId} value={wallet.walletId}>
                        {formatWalletLabel(wallet)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CreateApiKeyDetailsStep({
  draft,
  wallets,
  selectedWallets,
  canContinue,
  environment,
  close,
  nextStep,
  setDraft,
  toggleWallet,
}: {
  draft: ApiKeyDraft;
  wallets: PaymentsDashboardWallet[];
  selectedWallets: PaymentsDashboardWallet[];
  canContinue: boolean;
  environment: SdpEnvironment;
  close: () => void;
  nextStep: () => void;
  setDraft: Dispatch<SetStateAction<ApiKeyDraft>>;
  toggleWallet: (walletId: string) => void;
}) {
  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="create-key-name">Name</Label>
        <Input
          id="create-key-name"
          value={draft.name}
          onChange={(event) => {
            const name = event.currentTarget.value;
            setDraft((previous) => ({ ...previous, name }));
          }}
          placeholder="CI deploy key"
          required
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="create-key-role">Role</Label>
        <select
          id="create-key-role"
          value={draft.role}
          onChange={(event) => {
            const role = event.currentTarget.value as ApiKeyRole;
            setDraft((previous) => ({ ...previous, role }));
          }}
          className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
        >
          <option value="api_admin">Admin</option>
          <option value="api_developer">Developer</option>
          <option value="api_readonly">Read only</option>
        </select>
        <p className="text-xs text-[rgba(28,28,29,0.65)]">
          Admin includes custody and platform-level privileges. Developer excludes custody actions.
        </p>
      </div>

      <div className="grid gap-2">
        <Label>Environment</Label>
        <div className="flex h-10 items-center rounded-lg border border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.02)] px-3 text-sm text-[#1c1c1d]">
          {formatEnvironmentLabel(environment)}
        </div>
        <p className="text-xs text-[rgba(28,28,29,0.65)]">
          Switch the workspace environment in the sidebar to create a key in the other environment.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="create-key-expires-at">Expiration (optional)</Label>
        <Input
          id="create-key-expires-at"
          name="expiresAt"
          type="datetime-local"
          value={draft.expiresAt}
          onChange={(event) => {
            const expiresAt = event.currentTarget.value;
            setDraft((previous) => ({ ...previous, expiresAt }));
          }}
        />
      </div>

      <WalletAccessSection
        draft={draft}
        wallets={wallets}
        selectedWallets={selectedWallets}
        setDraft={setDraft}
        toggleWallet={toggleWallet}
      />

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button type="button" disabled={!canContinue} onClick={nextStep}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function CreateApiKeyReviewStep({
  draft,
  selectedWallets,
  environment,
  onBack,
}: {
  draft: ApiKeyDraft;
  selectedWallets: PaymentsDashboardWallet[];
  environment: SdpEnvironment;
  onBack: () => void;
}) {
  const defaultSelectedWallet = resolveDefaultSelectedWallet(
    selectedWallets,
    draft.defaultWalletId
  );

  return (
    <form action={createApiKeyAction} className="mt-4 space-y-3">
      <input type="hidden" name="name" value={draft.name} />
      <input type="hidden" name="role" value={draft.role} />
      <input type="hidden" name="expiresAt" value={draft.expiresAt} />
      <input type="hidden" name="walletScope" value={draft.walletScope} />
      {draft.walletScope === "selected"
        ? selectedWallets.map((wallet) => (
            <input
              key={wallet.walletId}
              type="hidden"
              name="signingWalletIds"
              value={wallet.walletId}
            />
          ))
        : null}
      {draft.walletScope === "selected" && draft.defaultWalletId ? (
        <input type="hidden" name="signingWalletId" value={draft.defaultWalletId} />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-[rgba(28,28,29,0.12)] bg-white">
        <div className="flex flex-col gap-2 border-b border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-[#1c1c1d]">{draft.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[rgba(28,28,29,0.62)]">
              <span>{formatEnvironmentLabel(environment)}</span>
              <span aria-hidden="true">·</span>
              <span>Expires {formatDisplayDate(draft.expiresAt)}</span>
            </div>
          </div>
        </div>

        <div className="grid divide-y divide-[rgba(28,28,29,0.08)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <ReviewDetail icon={KeyRound} label="Endpoint permissions">
            {formatRoleLabel(draft.role)}
          </ReviewDetail>

          <ReviewDetail icon={Wallet} label="Wallet access">
            <div className="space-y-2">
              <p>
                {draft.walletScope === "all" ? "All wallets" : `${selectedWallets.length} selected`}
              </p>
              {draft.walletScope === "selected" ? (
                <div className="space-y-1.5 text-xs text-[rgba(28,28,29,0.62)]">
                  <p>
                    Default:{" "}
                    <span className="text-[#1c1c1d]">
                      {defaultSelectedWallet ? formatWalletLabel(defaultSelectedWallet) : "None"}
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedWallets.map((wallet) => (
                      <span
                        key={wallet.walletId}
                        className="max-w-full truncate rounded-sm bg-[rgba(28,28,29,0.06)] px-1.5 py-0.5"
                      >
                        {formatWalletLabel(wallet)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </ReviewDetail>
        </div>

        <div className="grid divide-y divide-[rgba(28,28,29,0.08)] border-t border-[rgba(28,28,29,0.08)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <ReviewDetail icon={ShieldCheck} label="Policy">
            <span className="text-[rgba(28,28,29,0.74)]">No API-key policy</span>
          </ReviewDetail>

          <ReviewDetail icon={Info} label="Security note">
            <span className="text-[rgba(28,28,29,0.74)]">
              The full key will only be shown once after creation.
            </span>
          </ReviewDetail>
        </div>
      </div>
      <CreateApiKeyReviewActions onBack={onBack} />
    </form>
  );
}

function CreateApiKeyReviewActions({ onBack }: { onBack: () => void }) {
  const { pending } = useFormStatus();

  return (
    <div className="mt-4 flex items-center justify-end gap-2 border-t border-[rgba(28,28,29,0.08)] pt-4">
      <Button type="button" variant="secondary" onClick={onBack} disabled={pending}>
        Back
      </Button>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Creating..." : "Create key"}
      </Button>
    </div>
  );
}

export function CreateApiKeyModal({
  wallets,
  triggerMode = "button",
  triggerLabel = "Create API key",
  triggerVariant = "default",
}: CreateApiKeyModalProps) {
  const { selectedProjectId, sdpEnvironment } = useDashboardWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<ApiKeyDraft>(normalizeDraft());

  const selectedWallets = wallets.filter((wallet) =>
    draft.selectedWalletIds.includes(wallet.walletId)
  );
  const canContinue =
    draft.name.trim().length > 0 &&
    Boolean(selectedProjectId) &&
    (draft.walletScope === "all" || draft.selectedWalletIds.length > 0);

  const close = () => {
    setIsOpen(false);
    setStep(1);
    setDraft(normalizeDraft());
  };

  const nextStep = () => {
    if (!canContinue) return;
    setStep(2);
  };

  const toggleWallet = (walletId: string) => {
    setDraft((previous) => {
      const alreadySelected = previous.selectedWalletIds.includes(walletId);
      const selectedWalletIds = alreadySelected
        ? previous.selectedWalletIds.filter((value) => value !== walletId)
        : [...previous.selectedWalletIds, walletId];
      const defaultWalletId = selectedWalletIds.includes(previous.defaultWalletId)
        ? previous.defaultWalletId
        : (selectedWalletIds[0] ?? "");

      return {
        ...previous,
        selectedWalletIds,
        defaultWalletId,
      };
    });
  };

  return (
    <>
      <Button
        type="button"
        size={triggerMode === "icon" ? "icon" : "default"}
        variant={triggerMode === "icon" ? "secondary" : triggerVariant}
        onClick={() => setIsOpen(true)}
        aria-label={triggerMode === "icon" ? "Create API key" : triggerLabel}
      >
        {triggerMode === "icon" ? (
          <>
            <Plus className="size-4" />
            <span className="sr-only">{triggerLabel}</span>
          </>
        ) : (
          triggerLabel
        )}
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={close}
        ariaLabel={step === 1 ? "Create API key" : "Review API key"}
        closeLabel="Close API key creation modal"
        contentClassName="flex max-h-[calc(100dvh-4rem)] flex-col overflow-hidden p-6"
        size="xl"
      >
        <div className="shrink-0 pr-12">
          <p className="text-sm font-semibold text-[#1c1c1d]">
            {step === 1 ? "Create API key" : "Review API key"}
          </p>
          <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
            {step === 1
              ? "Define key details and wallet access, then confirm."
              : "Review the request before creating the key."}
          </p>
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          {step === 1 ? (
            <CreateApiKeyDetailsStep
              draft={draft}
              wallets={wallets}
              selectedWallets={selectedWallets}
              canContinue={canContinue}
              environment={sdpEnvironment}
              close={close}
              nextStep={nextStep}
              setDraft={setDraft}
              toggleWallet={toggleWallet}
            />
          ) : selectedProjectId ? (
            <CreateApiKeyReviewStep
              draft={draft}
              selectedWallets={selectedWallets}
              environment={sdpEnvironment}
              onBack={() => setStep(1)}
            />
          ) : null}
        </div>
      </Modal>
    </>
  );
}
