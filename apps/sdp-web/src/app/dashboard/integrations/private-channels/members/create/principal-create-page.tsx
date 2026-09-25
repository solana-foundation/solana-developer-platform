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
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { createAndVerifyPrincipalAction } from "../actions";

const PRINCIPALS_PATH = "/dashboard/integrations/private-channels/members";

function shortKey(publicKey: string): string {
  return publicKey.length > 12 ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}` : publicKey;
}

function walletLabel(wallet: CustodyWalletSummary): string {
  const name = wallet.label ?? formatCustodyProviderName(wallet.provider ?? "wallet");
  return `${name} (${shortKey(wallet.publicKey)})`;
}

export function PrincipalCreatePage({
  projectId,
  wallets,
}: {
  /** The project this wizard rendered under; wallet verification binds to it. */
  projectId: string;
  wallets: CustodyWalletSummary[];
}) {
  const router = useRouter();
  const t = useTranslations();
  const workspace = useOptionalDashboardWorkspace();
  const custodyEnabled = workspace?.flags.custody ?? true;
  const [name, setName] = useState("");
  const [walletId, setWalletId] = useState("");
  const [createdPrincipalId, setCreatedPrincipalId] = useState<string | null>(null);
  // Set when a submit ends without any response at all: the server may have
  // created the principal, but the wizard never learned its id. The next
  // submit attests the lost response so the action can resume the same-named
  // principal instead of reporting a duplicate-name conflict.
  const [responseLost, setResponseLost] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || !walletId) return;

    startTransition(async () => {
      let result: Awaited<ReturnType<typeof createAndVerifyPrincipalAction>>;
      try {
        // One guarded server action: the stale-selection check runs before the
        // principal is created and both writes bind to the rendered project, so
        // a sibling tab that moves the shared cookie can no longer reject the
        // verification after the principal was already created.
        result = await createAndVerifyPrincipalAction({
          name: trimmedName,
          walletId,
          projectId,
          principalId: createdPrincipalId ?? undefined,
          isRetry: responseLost || undefined,
        });
        setResponseLost(false);
      } catch {
        // The response was lost outright (network failure, timeout), so the
        // outcome — including any created principal id — never arrived. The
        // name stays locked so a retry resumes the same submission.
        setResponseLost(true);
        toast.error(t("DashboardPrivateChannels.members.submitInterrupted"));
        return;
      }
      if (!result.ok) {
        if (result.principalId) {
          // The principal exists but is unverified; a retry re-runs only the
          // verification instead of creating a duplicate.
          setCreatedPrincipalId(result.principalId);
        }
        toast.error(result.message);
        return;
      }

      toast.success(
        t("DashboardPrivateChannels.members.createSuccessWithWallet", { name: trimmedName })
      );
      router.push(PRINCIPALS_PATH);
      router.refresh();
    });
  };

  // An id-carrying retry or a lost-response retry re-runs the same submission,
  // so the wizard shows the retry affordance and keeps the name locked.
  const resuming = createdPrincipalId !== null || responseLost;

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
              ? resuming
                ? t("DashboardPrivateChannels.members.verifyingWallet")
                : t("DashboardPrivateChannels.members.creating")
              : resuming
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
            disabled={pending || resuming}
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
            {custodyEnabled ? (
              <Link className="font-medium underline underline-offset-4" href="/dashboard/wallets">
                {t("DashboardPrivateChannels.members.noWalletsLink")}
              </Link>
            ) : null}
            {t("DashboardPrivateChannels.members.noWalletsAfter")}
          </Callout>
        ) : null}
      </div>
    </WizardFrame>
  );
}
