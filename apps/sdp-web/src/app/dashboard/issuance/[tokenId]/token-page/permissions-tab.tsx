"use client";

import {
  FileTextIcon,
  KeyRoundIcon,
  type LucideIcon,
  PencilIcon,
  SnowflakeIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { getTokenTypeLabel } from "../../issuance-token-fields";
import type { PermissionRowId } from "../token-management-workspace.types";
import {
  accessControlLabel,
  holderName,
  shortAddress,
  type TokenTabProps,
} from "./token-page.shared";

const ROW_ICON: Record<PermissionRowId, LucideIcon> = {
  "mint-authority": KeyRoundIcon,
  "freeze-authority": SnowflakeIcon,
  "metadata-authority": FileTextIcon,
  "permanent-delegate": UsersIcon,
};

const ROW_COPY: Record<PermissionRowId, { title: MessageKey; why: MessageKey }> = {
  "mint-authority": {
    title: "DashboardIssuance.newDesign.permissions.mint",
    why: "DashboardIssuance.newDesign.permissions.mintWhy",
  },
  "freeze-authority": {
    title: "DashboardIssuance.newDesign.permissions.freeze",
    why: "DashboardIssuance.newDesign.permissions.freezeWhy",
  },
  "metadata-authority": {
    title: "DashboardIssuance.newDesign.permissions.metadata",
    why: "DashboardIssuance.newDesign.permissions.metadataWhy",
  },
  "permanent-delegate": {
    title: "DashboardIssuance.newDesign.permissions.delegate",
    why: "DashboardIssuance.newDesign.permissions.delegateWhy",
  },
};

/**
 * Who holds each of the token's keys, and what the token was built with. A draft's holders
 * are picked from the project's wallets and saved with the draft; a deployed token's move on
 * chain through the authority dialog.
 */
export function TokenPermissionsTab({
  token,
  ops,
  form,
  state,
  canManageTokenAdmin,
}: TokenTabProps) {
  const t = useTranslations();
  const [editing, setEditing] = useState<PermissionRowId | null>(null);
  const [choice, setChoice] = useState("");
  const draft = !token.mintAddress;
  const walletName = (id: string | undefined) => {
    const wallet = ops.authorityWallets.find((candidate) => candidate.id === id);
    return wallet
      ? wallet.label?.trim() || shortAddress(wallet.publicKey)
      : t("DashboardIssuance.newDesign.notSet");
  };
  const draftHolderId = (id: PermissionRowId) =>
    form.draft.authorityWalletIds?.[id] ?? form.draft.signingWalletId;

  const extensions: { name: string; why: string; state: string; tone: StatusTone }[] = [
    {
      name: t("DashboardIssuance.newDesign.permissions.template"),
      why: t("DashboardIssuance.newDesign.permissions.templateWhy"),
      state: getTokenTypeLabel(token.template, t),
      tone: "neutral",
    },
    enabledRow(t, "freezable", token.isFreezable),
    {
      name: accessControlLabel(ops.accessControlMode, t),
      why: t(
        ops.accessControlMode === "allowlist"
          ? "DashboardIssuance.newDesign.permissions.allowlistWhy"
          : ops.accessControlMode === "blocklist"
            ? "DashboardIssuance.newDesign.permissions.blocklistWhy"
            : "DashboardIssuance.newDesign.permissions.noListWhy"
      ),
      state: t(
        ops.accessControlMode === "disabled"
          ? "DashboardIssuance.newDesign.permissions.off"
          : "DashboardIssuance.newDesign.permissions.enabled"
      ),
      tone: ops.accessControlMode === "disabled" ? "neutral" : "positive",
    },
    enabledRow(
      t,
      "pausable",
      Boolean(token.extensions?.pausable) || token.template === "stablecoin"
    ),
    enabledRow(
      t,
      "permanentDelegate",
      Boolean(token.extensions?.permanentDelegate) || token.template === "stablecoin"
    ),
    enabledRow(t, "mintable", token.isMintable && state !== "revoked"),
  ];

  return (
    <RecordStack>
      {state === "revoked" ? (
        <p className="max-w-[40em] text-body text-secondary">
          {t("DashboardIssuance.newDesign.operations.revokedNote")}
        </p>
      ) : null}
      {ops.authoritySummary.hasExternal ? (
        <p className="max-w-[40em] text-body text-warning">
          {t("DashboardIssuance.newDesign.permissions.externalNote")}
        </p>
      ) : null}
      <RecordBlock title={t("DashboardIssuance.newDesign.tabs.permissions")}>
        <div className="flex flex-col">
          {ops.permissionRows.map((row) => {
            const Icon = ROW_ICON[row.id];
            const copy = ROW_COPY[row.id];
            const holder = draft
              ? walletName(draftHolderId(row.id))
              : holderName(row.value, ops.authorityWallets, t);
            const editDisabled =
              !canManageTokenAdmin ||
              ops.isPending ||
              form.saving ||
              Boolean(row.editDisabledReason) ||
              state === "revoked";
            return (
              <div
                key={row.id}
                data-token-permission={row.id}
                className="flex flex-col gap-3 border-b border-border-subtle py-4 first:pt-0 last:border-b-0"
              >
                <div className="flex flex-col items-start gap-3 @xl:flex-row @xl:justify-between">
                  <span className="flex min-w-0 items-start gap-3">
                    <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-tertiary" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-body font-medium text-primary">{t(copy.title)}</span>
                      <span className="text-meta text-secondary">{t(copy.why)}</span>
                    </span>
                  </span>
                  {editing === row.id ? null : (
                    <span className="flex shrink-0 items-center gap-3 ps-7 @xl:ps-0">
                      <span className="text-body text-primary">{holder}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={editDisabled}
                        onClick={() => {
                          if (draft) {
                            setChoice(draftHolderId(row.id) ?? "");
                            setEditing(row.id);
                          } else {
                            ops.handleAuthorityModalOpen(row);
                          }
                        }}
                        iconLeft={<PencilIcon aria-hidden="true" />}
                      >
                        {t("DashboardIssuance.newDesign.permissions.edit")}
                      </Button>
                    </span>
                  )}
                </div>
                {editing === row.id ? (
                  <div className="flex max-w-lg flex-col gap-4 ps-7">
                    <Select
                      ariaLabel={t(copy.title)}
                      placeholder={t("DashboardIssuance.signer.select")}
                      value={
                        ops.authorityWallets.some((wallet) => wallet.id === choice) ? choice : ""
                      }
                      onValueChange={(value) => setChoice(value ?? "")}
                    >
                      {ops.authorityWallets.map((wallet) => (
                        <SelectItem key={wallet.id} value={wallet.id}>
                          {wallet.label?.trim() || shortAddress(wallet.publicKey)}
                        </SelectItem>
                      ))}
                    </Select>
                    <p className="text-meta text-secondary">
                      {t("DashboardIssuance.newDesign.permissions.draftHolderHint")}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={!choice || form.saving}
                        onClick={async () => {
                          form.updateDraft({
                            ...(row.id === "mint-authority" ? { signingWalletId: choice } : {}),
                            authorityWalletIds: {
                              ...form.draft.authorityWalletIds,
                              [row.id]: choice,
                            },
                          });
                          setEditing(null);
                        }}
                      >
                        {t("DashboardIssuance.newDesign.permissions.keep")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                        {t("DashboardIssuance.newDesign.permissions.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {draft && form.dirty ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={form.saving} onClick={() => void form.save()}>
              {form.saving
                ? t("DashboardIssuance.newDesign.details.saving")
                : t("DashboardIssuance.newDesign.details.saveChanges")}
            </Button>
            <Button variant="ghost" size="sm" disabled={form.saving} onClick={form.discard}>
              {t("DashboardIssuance.newDesign.details.discard")}
            </Button>
            <span className="text-meta text-secondary">
              {t("DashboardIssuance.newDesign.details.nothingSaved")}
            </span>
          </div>
        ) : null}
      </RecordBlock>

      <RecordBlock title={t("DashboardIssuance.newDesign.permissions.extensions")}>
        <div className="flex flex-col">
          {extensions.map((extension) => (
            <div
              key={extension.name}
              className="flex items-start justify-between gap-3 border-b border-border-subtle py-4 first:pt-0 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-body font-medium text-primary">{extension.name}</span>
                <span className="text-meta text-secondary">{extension.why}</span>
              </span>
              <StatusText tone={extension.tone} className="shrink-0 text-body">
                {extension.state}
              </StatusText>
            </div>
          ))}
        </div>
      </RecordBlock>
    </RecordStack>
  );
}

function enabledRow(
  t: ReturnType<typeof useTranslations>,
  key: "freezable" | "pausable" | "permanentDelegate" | "mintable",
  on: boolean
): { name: string; why: string; state: string; tone: StatusTone } {
  const copy: Record<typeof key, { name: MessageKey; why: MessageKey }> = {
    freezable: {
      name: "DashboardIssuance.newDesign.permissions.freezable",
      why: "DashboardIssuance.newDesign.permissions.freezableWhy",
    },
    pausable: {
      name: "DashboardIssuance.newDesign.permissions.pausable",
      why: "DashboardIssuance.newDesign.permissions.pausableWhy",
    },
    permanentDelegate: {
      name: "DashboardIssuance.newDesign.permissions.delegate",
      why: "DashboardIssuance.newDesign.permissions.delegateExtensionWhy",
    },
    mintable: {
      name: "DashboardIssuance.newDesign.permissions.mintable",
      why: "DashboardIssuance.newDesign.permissions.mintableWhy",
    },
  };
  return {
    name: t(copy[key].name),
    why: t(copy[key].why),
    state: t(
      on
        ? "DashboardIssuance.newDesign.permissions.enabled"
        : "DashboardIssuance.newDesign.permissions.off"
    ),
    tone: on ? "positive" : "neutral",
  };
}
