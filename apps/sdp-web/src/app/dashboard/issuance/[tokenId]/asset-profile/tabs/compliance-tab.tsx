"use client";

import type { Token } from "@sdp/types";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { AdvancedCapacities } from "../../../create/advanced-capacities";
import {
  ACCESS_CONTROL_OPTIONS,
  accessControlLabel,
} from "../../../create/asset-details-config";
import { FormCard, ReadOnlyField } from "../../../create/form-primitives";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { TokenControlListsSection } from "../../token-control-lists-section";
import type { AdminAction } from "../../token-management-workspace.types";
import type { AssetProfileForm } from "../use-asset-profile-form";
import type { TokenOperations } from "../use-token-operations";
import { ActionPills } from "./action-pills";
import { OpsActionForms } from "./ops-action-forms";

export function ComplianceTab({
  token,
  form,
  ops,
  canManageTokenAdmin,
}: {
  token: Token;
  form: AssetProfileForm;
  ops: TokenOperations;
  canManageTokenAdmin: boolean;
}) {
  const { draft, updateDraft } = form;
  const isDeployed = Boolean(token.mintAddress);
  const enforcedLabel =
    accessControlLabel(ops.accessControlMode) ?? "No transfer restrictions";

  const availableActions: Array<{ id: AdminAction; label: string }> = [
    ...(ops.controlListCopy ? [{ id: "allowlist" as const, label: ops.controlListCopy.label }] : []),
    ...(canManageTokenAdmin
      ? [
          { id: "freeze" as const, label: "Freeze" },
          { id: "pause" as const, label: "Pause" },
        ]
      : []),
  ];
  const [activeAction, setActiveAction] = useState<AdminAction | null>(
    availableActions[0]?.id ?? null
  );

  return (
    <div className="space-y-5">
      <FormCard
        title="Access policy"
        description="Documents the intended access policy for this asset."
        icon={ShieldCheck}
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          {isDeployed ? (
            <ReadOnlyField
              label="Access control"
              value={accessControlLabel(draft.accessControl) ?? "Not set"}
              lockReason="Locked after deployment — on-chain enforcement can't be changed."
            />
          ) : (
            <div className="max-w-xs">
              <Label>Access control</Label>
              <div className="mt-1.5">
                <Select
                  value={draft.accessControl || null}
                  onValueChange={(value) =>
                    updateDraft({ accessControl: (value ?? "") as DraftState["accessControl"] })
                  }
                  placeholder="Select access control"
                >
                  {ACCESS_CONTROL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <p className="mt-1.5 text-xs text-[rgba(28,28,29,0.5)]">
                Applied on-chain when the token deploys.
              </p>
            </div>
          )}
          <ReadOnlyField
            label="Enforced on-chain"
            value={enforcedLabel}
            lockReason="On-chain enforcement was configured at creation."
          />
        </div>
      </FormCard>

      <AdvancedCapacities
        value={draft.capacities}
        onChange={(key, checked) =>
          updateDraft({ capacities: { ...draft.capacities, [key]: checked } })
        }
      />

      {availableActions.length > 0 ? (
        <div className="space-y-4 pt-2">
          <div>
            <p className="text-base font-medium text-[#1c1c1d]">Compliance controls</p>
            <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">
              On-chain actions for this token — these take effect immediately.
            </p>
          </div>
          <ActionPills
            actions={availableActions}
            activeAction={activeAction}
            disabledReasons={ops.complianceActionDisabledReasons}
            onSelectAction={setActiveAction}
          />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <OpsActionForms ops={ops} token={token} activeAction={activeAction} />
            </div>
            <TokenControlListsSection
              showControlList={ops.showControlList}
              controlListLabel={ops.controlListCopy?.label ?? null}
              allowlistEntriesCount={ops.allowlistEntries.length}
              allowlistError={ops.allowlistError}
              allowlistTotal={ops.allowlistTotal}
              allowlistHasMore={ops.allowlistHasMore}
              frozenAccountsCount={ops.frozenAccounts.length}
              frozenAccountsError={ops.frozenAccountsError}
              frozenAccountsTotal={ops.frozenAccountsTotal}
              frozenAccountsHasMore={ops.frozenAccountsHasMore}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
