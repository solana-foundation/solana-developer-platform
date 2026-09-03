"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import type { DvpCreateContext } from "./dvp-create.data";

/** Token-2022, the program almost every SDP-issued asset uses. */
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** A month out. Long enough to fund and settle, well inside the program's cap. */
function defaultExpiry(): string {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function Field({
  children,
  hint,
  htmlFor,
  label,
}: {
  children: React.ReactNode;
  hint?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-tertiary text-xs leading-relaxed">{hint}</p> : null}
    </div>
  );
}

export function DvpCreateWorkspace({ context }: { context: DvpCreateContext }) {
  const t = useTranslations();
  const router = useRouter();

  const tradableTokens = context.tokens.filter((token) => token.blockedReason === null);
  const [walletId, setWalletId] = useState(context.wallets[0]?.id ?? "");
  const [sdpSide, setSdpSide] = useState<"a" | "b">("a");
  const [counterparty, setCounterparty] = useState("");
  const [mintA, setMintA] = useState(tradableTokens[0]?.mint ?? "");
  const [mintB, setMintB] = useState("");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [expiry, setExpiry] = useState(defaultExpiry());
  const [refString, setRefString] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAsset = context.tokens.find((token) => token.mint === mintA);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/markets/dvp/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The form is one logical request; a double-submit or a retry after a
          // dropped connection must not create a second trade.
          "Idempotency-Key": `dvp-create-${walletId}-${counterparty}-${amountA}-${amountB}-${expiry}`,
        },
        body: JSON.stringify({
          sdpWalletId: walletId,
          sdpSide,
          counterparty: counterparty.trim(),
          mintA: mintA.trim(),
          mintB: mintB.trim(),
          tokenProgramA: selectedAsset?.tokenProgram || TOKEN_2022,
          tokenProgramB: TOKEN_2022,
          amountA: amountA.trim(),
          amountB: amountB.trim(),
          // The API takes unix seconds as a string; a date input gives a day.
          expiryTimestamp: String(Math.floor(new Date(`${expiry}T23:59:59Z`).getTime() / 1000)),
          ...(refString.trim() ? { refString: refString.trim() } : {}),
        }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        data?: { trade?: { id?: string } };
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(body.error?.message ?? `Create failed (${response.status}).`);
        return;
      }

      const id = body.data?.trade?.id;
      router.push(
        id ? `${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${id}` : DASHBOARD_MARKETS_SUBNAV_HREFS.dvp
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <form className="mx-auto flex w-full max-w-2xl flex-col gap-5" onSubmit={submit}>
        <p className="text-secondary text-sm leading-relaxed">
          {t("DashboardMarkets.dvp.createDescription")}
        </p>

        {context.error ? <Callout variant="danger">{context.error}</Callout> : null}

        <Field
          hint={t("DashboardMarkets.dvp.fieldWalletHint")}
          htmlFor="dvp-wallet"
          label={t("DashboardMarkets.dvp.fieldWallet")}
        >
          <select
            className="rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-primary text-sm"
            id="dvp-wallet"
            onChange={(event) => setWalletId(event.target.value)}
            required
            value={walletId}
          >
            {context.wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.label ?? wallet.address}
              </option>
            ))}
          </select>
        </Field>

        <Field htmlFor="dvp-side" label={t("DashboardMarkets.dvp.fieldSide")}>
          <select
            className="rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-primary text-sm"
            id="dvp-side"
            onChange={(event) => setSdpSide(event.target.value as "a" | "b")}
            value={sdpSide}
          >
            <option value="a">{t("DashboardMarkets.dvp.sideAsset")}</option>
            <option value="b">{t("DashboardMarkets.dvp.sideCash")}</option>
          </select>
        </Field>

        <Field
          hint={t("DashboardMarkets.dvp.fieldCounterpartyHint")}
          htmlFor="dvp-counterparty"
          label={t("DashboardMarkets.dvp.fieldCounterparty")}
        >
          <Input
            id="dvp-counterparty"
            onChange={(event) => setCounterparty(event.target.value)}
            placeholder="7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"
            required
            value={counterparty}
          />
        </Field>

        <Field
          hint={
            context.tokens.length === 0
              ? t("DashboardMarkets.dvp.createEmptyTokens")
              : t("DashboardMarkets.dvp.fieldAssetMintHint")
          }
          htmlFor="dvp-mint-a"
          label={t("DashboardMarkets.dvp.fieldAssetMint")}
        >
          {context.tokens.length > 0 ? (
            <select
              className="rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-primary text-sm"
              id="dvp-mint-a"
              onChange={(event) => setMintA(event.target.value)}
              value={mintA}
            >
              {/* A token the program refuses is shown DISABLED with its reason
                  rather than filtered out. Omitting it silently would leave
                  someone hunting for a token they can see in Issuance, and the
                  reason is the thing actually worth learning. */}
              {context.tokens.map((token) => (
                <option disabled={token.blockedReason !== null} key={token.mint} value={token.mint}>
                  {token.blockedReason
                    ? `${token.label} — ${t("DashboardMarkets.dvp.tokenBlocked")} (${token.blockedReason})`
                    : token.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="dvp-mint-a"
              onChange={(event) => setMintA(event.target.value)}
              required
              value={mintA}
            />
          )}
        </Field>

        <Field htmlFor="dvp-mint-b" label={t("DashboardMarkets.dvp.fieldCashMint")}>
          <Input
            id="dvp-mint-b"
            onChange={(event) => setMintB(event.target.value)}
            placeholder="AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"
            required
            value={mintB}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            hint={t("DashboardMarkets.dvp.fieldAmountHint")}
            htmlFor="dvp-amount-a"
            label={t("DashboardMarkets.dvp.fieldAmountA")}
          >
            {/* inputMode numeric, not type=number: these are u64 base units and
                a number input would round them above 2^53. */}
            <Input
              id="dvp-amount-a"
              inputMode="numeric"
              onChange={(event) => setAmountA(event.target.value)}
              pattern="[0-9]+"
              required
              value={amountA}
            />
          </Field>
          <Field
            hint={t("DashboardMarkets.dvp.fieldAmountHint")}
            htmlFor="dvp-amount-b"
            label={t("DashboardMarkets.dvp.fieldAmountB")}
          >
            <Input
              id="dvp-amount-b"
              inputMode="numeric"
              onChange={(event) => setAmountB(event.target.value)}
              pattern="[0-9]+"
              required
              value={amountB}
            />
          </Field>
        </div>

        <Field
          hint={t("DashboardMarkets.dvp.fieldExpiryHint")}
          htmlFor="dvp-expiry"
          label={t("DashboardMarkets.dvp.fieldExpiry")}
        >
          <Input
            id="dvp-expiry"
            onChange={(event) => setExpiry(event.target.value)}
            required
            type="date"
            value={expiry}
          />
        </Field>

        <Field
          hint={t("DashboardMarkets.dvp.fieldRefHint")}
          htmlFor="dvp-ref"
          label={t("DashboardMarkets.dvp.fieldRef")}
        >
          <Input
            id="dvp-ref"
            maxLength={64}
            onChange={(event) => setRefString(event.target.value)}
            value={refString}
          />
        </Field>

        {error ? (
          <Callout live variant="danger">
            {error}
          </Callout>
        ) : null}

        <div className="flex items-center gap-3">
          <Button disabled={submitting || !walletId} type="submit">
            {submitting
              ? t("DashboardMarkets.dvp.createSubmitting")
              : t("DashboardMarkets.dvp.createAction")}
          </Button>
        </div>
      </form>
    </DashboardWorkspaceOverviewPanel>
  );
}
