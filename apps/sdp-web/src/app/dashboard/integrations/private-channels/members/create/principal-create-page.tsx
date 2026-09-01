"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { IdCardIcon, Loader2Icon, WalletCardsIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { verifyWalletAction } from "../../wallets/actions";
import { createPrincipalAction } from "../actions";

const PRINCIPALS_PATH = "/dashboard/integrations/private-channels/members";

function shortKey(publicKey: string): string {
  return publicKey.length > 12 ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}` : publicKey;
}

function walletLabel(wallet: CustodyWalletSummary): string {
  const name = wallet.label ?? formatCustodyProviderName(wallet.provider ?? "wallet");
  return `${name} (${shortKey(wallet.publicKey)})`;
}

export function PrincipalCreatePage({ wallets }: { wallets: CustodyWalletSummary[] }) {
  const router = useRouter();
  const t = useTranslations();
  const [name, setName] = useState("");
  const [walletId, setWalletId] = useState("");
  const [createdPrincipalId, setCreatedPrincipalId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || !walletId) return;

    startTransition(async () => {
      let principalId = createdPrincipalId;
      if (!principalId) {
        const principalResult = await createPrincipalAction(trimmedName);
        if (!principalResult.ok) {
          toast.error(principalResult.message);
          return;
        }
        principalId = principalResult.value.id;
        setCreatedPrincipalId(principalId);
      }

      const walletResult = await verifyWalletAction(walletId, principalId);
      if (!walletResult.ok) {
        toast.error(walletResult.message);
        return;
      }

      toast.success(
        t("DashboardPrivateChannels.members.createSuccessWithWallet", { name: trimmedName })
      );
      router.push(PRINCIPALS_PATH);
      router.refresh();
    });
  };

  const steps = [
    {
      label: t("DashboardPrivateChannels.members.createStepLabel"),
      title: t("DashboardPrivateChannels.members.createTitle"),
    },
  ];

  return (
    <WizardFrame
      steps={steps}
      currentStep={0}
      progressLabel={t("DashboardPrivateChannels.members.createStepProgress")}
      description={t("DashboardPrivateChannels.members.createDescription")}
      maxWidthClassName="max-w-xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.push(PRINCIPALS_PATH)}
            disabled={pending}
          >
            {t("DashboardPrivateChannels.common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={name.trim().length < 2 || !walletId || pending}
            iconLeft={pending ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {pending
              ? createdPrincipalId
                ? t("DashboardPrivateChannels.members.verifyingWallet")
                : t("DashboardPrivateChannels.members.creating")
              : createdPrincipalId
                ? t("DashboardPrivateChannels.members.retryWallet")
                : t("DashboardPrivateChannels.members.create")}
          </Button>
        </div>
      }
    >
      <div className="space-y-6 px-1 py-1">
        <div className="space-y-2">
          <Label htmlFor="principal-name">
            {t("DashboardPrivateChannels.members.principalName")}
          </Label>
          <Input
            size="xl"
            id="principal-name"
            iconLeft={<IdCardIcon />}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending || createdPrincipalId !== null}
            maxLength={64}
            placeholder={t("DashboardPrivateChannels.members.principalNamePlaceholder")}
          />
        </div>

        <div className="space-y-2">
          <Label>{t("DashboardPrivateChannels.members.wallet")}</Label>
          <Select
            size="xl"
            value={walletId}
            onValueChange={(value) => setWalletId(value ?? "")}
            disabled={pending || wallets.length === 0}
            ariaLabel={t("DashboardPrivateChannels.members.wallet")}
            placeholder={t("DashboardPrivateChannels.members.walletPlaceholder")}
            iconLeft={<WalletCardsIcon />}
          >
            {wallets.map((wallet) => (
              <SelectItem key={wallet.walletId} value={wallet.walletId}>
                {walletLabel(wallet)}
              </SelectItem>
            ))}
          </Select>
          <p className="text-xs text-tertiary">
            {t("DashboardPrivateChannels.members.walletDescription")}
          </p>
        </div>

        {wallets.length === 0 ? (
          <Callout variant="info">
            {t("DashboardPrivateChannels.members.noWalletsBefore")}{" "}
            <Link className="font-medium underline underline-offset-4" href="/dashboard/wallets">
              {t("DashboardPrivateChannels.members.noWalletsLink")}
            </Link>
            {t("DashboardPrivateChannels.members.noWalletsAfter")}
          </Callout>
        ) : null}
      </div>
    </WizardFrame>
  );
}
