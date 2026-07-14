"use client";

import type { CounterpartyAccount } from "@sdp/types";
import { CheckCircle2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { useCounterpartyCreate } from "./counterparty-create-context";
import { CryptoAccountForm } from "./crypto-account-form";

export function CryptoAccountsPhase() {
  const t = useTranslations();
  const { createdCounterparty, finish } = useCounterpartyCreate();
  const [accounts, setAccounts] = useState<CounterpartyAccount[]>([]);

  if (!createdCounterparty) return null;

  return (
    <div className="mx-auto flex h-[70vh] max-w-xl flex-col py-4">
      <div className="flex items-center gap-2 text-success">
        <CheckCircle2Icon className="size-5" />
        <span className="text-sm font-medium">
          {t("DashboardPayments.counterparty.created", { name: createdCounterparty.displayName })}
        </span>
      </div>

      <div className="mt-6 min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
        <div className="space-y-1">
          <h2 className="text-2xl font-medium tracking-tight text-primary">
            {t("DashboardPayments.counterparty.addCryptoAccount")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPayments.counterparty.addCryptoAccountDescription")}
          </p>
        </div>

        {accounts.length > 0 && (
          <ul className="space-y-2">
            {accounts.map((account) => {
              const details = account.details as { network?: string; address?: string };
              return (
                <li
                  key={account.id}
                  className="flex items-center justify-between rounded-xl border border-border-primary px-3 py-2 text-sm"
                >
                  <span className="text-primary">
                    {account.label ?? t("DashboardPayments.counterparty.cryptoWallet")}
                  </span>
                  <span className="truncate pl-3 font-mono text-xs text-secondary">
                    {details.network} · {details.address}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <CryptoAccountForm
          counterpartyId={createdCounterparty.id}
          onAdded={(account) => setAccounts((prev) => [account, ...prev])}
        />
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={finish}>
          {accounts.length > 0
            ? t("DashboardPayments.counterparty.done")
            : t("DashboardPayments.counterparty.skip")}
        </Button>
      </div>
    </div>
  );
}
