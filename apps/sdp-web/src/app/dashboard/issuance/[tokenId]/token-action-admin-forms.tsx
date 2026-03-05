"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TokenAllowlistEntry } from "@sdp/types";
import type { Dispatch, SetStateAction } from "react";
import { TokenActionCard } from "./token-action-card";
import type {
  AdminAction,
  AllowlistFormState,
  AuthorityFormState,
  ForceBurnFormState,
  FreezeFormState,
  SeizeFormState,
} from "./token-management-workspace.types";

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
  onSeize: (mode: "prepare" | "execute") => void;
  onForceBurn: (mode: "prepare" | "execute") => void;
  onAuthorityUpdate: (mode: "prepare" | "execute") => void;
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
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Source
              <Input
                value={seizeForm.source}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, source: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Destination
              <Input
                value={seizeForm.destination}
                onChange={(event) =>
                  setSeizeForm((previous) => ({
                    ...previous,
                    destination: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={seizeForm.amount}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, amount: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Delegate Authority (optional)
              <Input
                value={seizeForm.delegateAuthority}
                onChange={(event) =>
                  setSeizeForm((previous) => ({
                    ...previous,
                    delegateAuthority: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Memo
              <Input
                value={seizeForm.memo}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, memo: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onSeize("prepare")}
              disabled={isPending}
            >
              Seize (prepare)
            </Button>
            <Button type="button" onClick={() => onSeize("execute")} disabled={isPending}>
              Seize (execute)
            </Button>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "force-burn" ? (
        <TokenActionCard
          title="Force Burn"
          description="Administrative forced burn from source account."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Source
              <Input
                value={forceBurnForm.source}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({
                    ...previous,
                    source: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={forceBurnForm.amount}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({
                    ...previous,
                    amount: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              Delegate Authority (optional)
              <Input
                value={forceBurnForm.delegateAuthority}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({
                    ...previous,
                    delegateAuthority: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              Memo
              <Input
                value={forceBurnForm.memo}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({
                    ...previous,
                    memo: event.currentTarget.value,
                  }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onForceBurn("prepare")}
              disabled={isPending}
            >
              Force Burn (prepare)
            </Button>
            <Button type="button" onClick={() => onForceBurn("execute")} disabled={isPending}>
              Force Burn (execute)
            </Button>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "authority" ? (
        <TokenActionCard title="Update Authority" description="Rotate or remove token authorities.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Role
              <select
                className="h-10 w-full rounded-[10px] border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm"
                value={authorityForm.role}
                onChange={(event) =>
                  setAuthorityForm((previous) => ({
                    ...previous,
                    role: event.currentTarget.value as AuthorityFormState["role"],
                  }))
                }
              >
                <option value="mint">mint</option>
                <option value="freeze">freeze</option>
                <option value="permanentDelegate">permanentDelegate</option>
                <option value="metadata">metadata</option>
              </select>
            </Label>
            <Label>
              Current Authority (optional)
              <Input
                value={authorityForm.currentAuthority}
                onChange={(event) =>
                  setAuthorityForm((previous) => ({
                    ...previous,
                    currentAuthority: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              New Authority (empty to remove)
              <Input
                value={authorityForm.newAuthority}
                onChange={(event) =>
                  setAuthorityForm((previous) => ({
                    ...previous,
                    newAuthority: event.currentTarget.value,
                  }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onAuthorityUpdate("prepare")}
              disabled={isPending}
            >
              Authority (prepare)
            </Button>
            <Button type="button" onClick={() => onAuthorityUpdate("execute")} disabled={isPending}>
              Authority (execute)
            </Button>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "pause" ? (
        <TokenActionCard title="Pause Controls" description="Pause or resume token-wide transfers.">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onPause(true)}
              disabled={isPending}
            >
              Pause token
            </Button>
            <Button type="button" onClick={() => onPause(false)} disabled={isPending}>
              Unpause token
            </Button>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "freeze" ? (
        <TokenActionCard title="Freeze Controls" description="Freeze or thaw a token account.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Account Address
              <Input
                value={freezeForm.accountAddress}
                onChange={(event) =>
                  setFreezeForm((previous) => ({
                    ...previous,
                    accountAddress: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              Reason (freeze only)
              <Input
                value={freezeForm.reason}
                onChange={(event) =>
                  setFreezeForm((previous) => ({ ...previous, reason: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onFreeze(false)}
              disabled={isPending}
            >
              Freeze account
            </Button>
            <Button type="button" onClick={() => onFreeze(true)} disabled={isPending}>
              Unfreeze account
            </Button>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "allowlist" ? (
        <TokenActionCard title="Allowlist" description="Add or remove allowlist addresses.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Address
              <Input
                value={allowlistForm.address}
                onChange={(event) =>
                  setAllowlistForm((previous) => ({
                    ...previous,
                    address: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              Label
              <Input
                value={allowlistForm.label}
                onChange={(event) =>
                  setAllowlistForm((previous) => ({
                    ...previous,
                    label: event.currentTarget.value,
                  }))
                }
              />
            </Label>
          </div>
          <Button type="button" onClick={onAddAllowlist} disabled={isPending}>
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
        </TokenActionCard>
      ) : null}
    </>
  );
}
