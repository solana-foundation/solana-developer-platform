"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TokenAllowlistEntry } from "@sdp/types";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { type ComponentProps, type Dispatch, type SetStateAction, useId } from "react";
import { TokenActionCard } from "./token-action-card";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";
import type {
  AdminAction,
  AllowlistFormState,
  AuthorityFormState,
  ForceBurnFormState,
  FreezeFormState,
  SeizeFormState,
} from "./token-management-workspace.types";
import { NON_WHITESPACE_PATTERN, SOLANA_ADDRESS_PATTERN } from "./token-management-workspace.utils";
import { TokenSignerSelect } from "./token-signer-select";

interface TokenActionAdminFormsProps {
  activeAction: AdminAction | null;
  isPending: boolean;
  seizeForm: SeizeFormState;
  setSeizeForm: Dispatch<SetStateAction<SeizeFormState>>;
  forceBurnForm: ForceBurnFormState;
  setForceBurnForm: Dispatch<SetStateAction<ForceBurnFormState>>;
  authorityForm: AuthorityFormState;
  setAuthorityForm: Dispatch<SetStateAction<AuthorityFormState>>;
  freezeForm: FreezeFormState;
  setFreezeForm: Dispatch<SetStateAction<FreezeFormState>>;
  allowlistForm: AllowlistFormState;
  setAllowlistForm: Dispatch<SetStateAction<AllowlistFormState>>;
  allowlistEntries: TokenAllowlistEntry[];
  allowlistError: string | null;
  signerWallets: PaymentsDashboardWallet[];
  signerUnavailableReason: string | null;
  tokenStatus: "pending" | "active" | "paused" | "revoked";
  onSignerWalletIdChange: (value: string) => void;
  onSeize: () => void;
  onForceBurn: () => void;
  onAuthorityUpdate: () => void;
  onPause: (pause: boolean) => void;
  onFreeze: (unfreeze: boolean) => void;
  onAddAllowlist: () => void;
  onRemoveAllowlist: (entryId: string) => void;
}

export function TokenActionAdminForms({
  activeAction,
  isPending,
  seizeForm,
  setSeizeForm,
  forceBurnForm,
  setForceBurnForm,
  authorityForm,
  setAuthorityForm,
  freezeForm,
  setFreezeForm,
  allowlistForm,
  setAllowlistForm,
  allowlistEntries,
  allowlistError,
  signerWallets,
  signerUnavailableReason,
  tokenStatus,
  onSignerWalletIdChange,
  onSeize,
  onForceBurn,
  onAuthorityUpdate,
  onPause,
  onFreeze,
  onAddAllowlist,
  onRemoveAllowlist,
}: TokenActionAdminFormsProps) {
  return (
    <>
      {activeAction === "seize" ? (
        <TokenActionCard
          title="Force Transfer"
          description="Administrative seizure transfer between accounts."
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSeize();
            }}
          >
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={seizeForm.signingWalletId}
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <ActionField
              label="Source"
              value={seizeForm.source}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setSeizeForm((previous) => ({
                  ...previous,
                  source: value,
                }))
              }
            />
            <ActionField
              label="Destination"
              value={seizeForm.destination}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setSeizeForm((previous) => ({
                  ...previous,
                  destination: value,
                }))
              }
            />
            <ActionField
              label="Amount"
              type="number"
              inputMode="decimal"
              min="0.000000001"
              step="any"
              value={seizeForm.amount}
              required
              onChange={(value) =>
                setSeizeForm((previous) => ({
                  ...previous,
                  amount: value,
                }))
              }
            />
            <ActionField
              label="Memo"
              value={seizeForm.memo}
              onChange={(value) =>
                setSeizeForm((previous) => ({
                  ...previous,
                  memo: value,
                }))
              }
            />
            <Button type="submit" disabled={isPending || Boolean(signerUnavailableReason)}>
              Force transfer
            </Button>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "force-burn" ? (
        <TokenActionCard
          title="Force Burn"
          description="Administrative forced burn from source account."
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onForceBurn();
            }}
          >
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={forceBurnForm.signingWalletId}
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <ActionField
              label="Source"
              value={forceBurnForm.source}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setForceBurnForm((previous) => ({
                  ...previous,
                  source: value,
                }))
              }
            />
            <ActionField
              label="Amount"
              type="number"
              inputMode="decimal"
              min="0.000000001"
              step="any"
              value={forceBurnForm.amount}
              required
              onChange={(value) =>
                setForceBurnForm((previous) => ({
                  ...previous,
                  amount: value,
                }))
              }
            />
            <ActionField
              label="Memo"
              value={forceBurnForm.memo}
              onChange={(value) =>
                setForceBurnForm((previous) => ({
                  ...previous,
                  memo: value,
                }))
              }
            />
            <Button type="submit" disabled={isPending || Boolean(signerUnavailableReason)}>
              Force burn
            </Button>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "authority" ? (
        <TokenActionCard title="Update Authority" description="Rotate or remove token authorities.">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onAuthorityUpdate();
            }}
          >
            <ActionSelect
              label="Role"
              value={authorityForm.role}
              onChange={(value) =>
                setAuthorityForm((previous) => ({
                  ...previous,
                  role: value as AuthorityFormState["role"],
                }))
              }
              options={[
                { label: "mint", value: "mint" },
                { label: "freeze", value: "freeze" },
                { label: "permanentDelegate", value: "permanentDelegate" },
                { label: "metadata", value: "metadata" },
              ]}
            />
            <ActionField
              label="Current Authority (optional)"
              value={authorityForm.currentAuthority}
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setAuthorityForm((previous) => ({
                  ...previous,
                  currentAuthority: value,
                }))
              }
            />
            <ActionField
              label="New Authority (empty to remove)"
              value={authorityForm.newAuthority}
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setAuthorityForm((previous) => ({
                  ...previous,
                  newAuthority: value,
                }))
              }
            />
            <Button type="submit" disabled={isPending}>
              Update authority
            </Button>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "pause" ? (
        <TokenActionCard title="Pause Controls" description="Pause or resume token-wide transfers.">
          <div className="flex flex-wrap gap-2">
            <TokenDisabledActionTooltip
              reason={tokenStatus === "paused" ? "Token is already paused." : null}
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => onPause(true)}
                disabled={isPending || tokenStatus === "paused"}
              >
                Pause token
              </Button>
            </TokenDisabledActionTooltip>
            <TokenDisabledActionTooltip
              reason={tokenStatus === "active" ? "Token is not paused." : null}
            >
              <Button
                type="button"
                onClick={() => onPause(false)}
                disabled={isPending || tokenStatus === "active"}
              >
                Unpause token
              </Button>
            </TokenDisabledActionTooltip>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "freeze" ? (
        <TokenActionCard title="Freeze Controls" description="Freeze or thaw a token account.">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const submitter = (event.nativeEvent as SubmitEvent).submitter;
              const action = submitter instanceof HTMLButtonElement ? submitter.value : "freeze";
              onFreeze(action === "unfreeze");
            }}
          >
            <ActionField
              label="Account Address"
              value={freezeForm.accountAddress}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setFreezeForm((previous) => ({
                  ...previous,
                  accountAddress: value,
                }))
              }
            />
            <ActionField
              label="Reason (freeze only)"
              value={freezeForm.reason}
              onChange={(value) =>
                setFreezeForm((previous) => ({
                  ...previous,
                  reason: value,
                }))
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" value="freeze" disabled={isPending}>
                Freeze account
              </Button>
              <Button type="submit" value="unfreeze" disabled={isPending}>
                Unfreeze account
              </Button>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "allowlist" ? (
        <TokenActionCard title="Allowlist" description="Add or remove allowlist addresses.">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onAddAllowlist();
            }}
          >
            <ActionField
              label="Address"
              value={allowlistForm.address}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setAllowlistForm((previous) => ({
                  ...previous,
                  address: value,
                }))
              }
            />
            <ActionField
              label="Label"
              value={allowlistForm.label}
              pattern={NON_WHITESPACE_PATTERN}
              title="Enter a label or leave this blank."
              onChange={(value) =>
                setAllowlistForm((previous) => ({
                  ...previous,
                  label: value,
                }))
              }
            />
            <Button type="submit" disabled={isPending}>
              Add allowlist entry
            </Button>

            {allowlistError ? (
              <p className="text-sm text-[#8a1f2a]">{allowlistError}</p>
            ) : allowlistEntries.length === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.68)]">No active allowlist entries.</p>
            ) : (
              <div className="space-y-2">
                {allowlistEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(28,28,29,0.12)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-[#1c1c1d]">{entry.address}</p>
                      <p className="text-xs text-[rgba(28,28,29,0.62)]">
                        {entry.label ?? "No label"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRemoveAllowlist(entry.id)}
                      disabled={isPending}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </form>
        </TokenActionCard>
      ) : null}
    </>
  );
}

function ActionField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  pattern,
  title,
  min,
  step,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: ComponentProps<typeof Input>["type"];
  required?: boolean;
  pattern?: string;
  title?: string;
  min?: string;
  step?: string;
  placeholder?: string;
  inputMode?: ComponentProps<typeof Input>["inputMode"];
}) {
  const fieldId = useId();

  return (
    <div className="space-y-2">
      <label
        htmlFor={fieldId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]"
      >
        {label}
      </label>
      <Input
        id={fieldId}
        type={type}
        value={value}
        required={required}
        pattern={pattern}
        title={title}
        min={min}
        step={step}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
      />
    </div>
  );
}

function ActionSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  const fieldId = useId();

  return (
    <div className="space-y-2">
      <label
        htmlFor={fieldId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]"
      >
        {label}
      </label>
      <select
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-11 w-full rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-white px-4 text-sm text-[#1c1c1d] shadow-none outline-none transition-[box-shadow,border-color] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
