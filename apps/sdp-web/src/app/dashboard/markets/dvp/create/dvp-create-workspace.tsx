"use client";

import { type SolanaCluster, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { ArrowRightIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { toBaseUnits } from "./dvp-amount";
import type { DvpCreateContext, DvpCreateOption } from "./dvp-create.data";

/** Sentinel for "not one of the listed mints", which opens a paste field. */
const CUSTOM = "__custom__";

const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];

/** A month out: long enough to fund and settle, well inside the program's cap. */
function defaultExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function Field({
  children,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
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

/**
 * One amount field, in whichever unit the mint allows.
 *
 * Where decimals are known it takes the amount as a person would write it and
 * shows the base units it resolves to, so the conversion is visible rather than
 * magic. Where they are not, it says so and takes base units, because guessing
 * a scale would move the wrong quantity.
 */
function AmountField({
  decimals,
  id,
  label,
  onChange,
  symbol,
  value,
}: {
  decimals: number | null;
  id: string;
  label: string;
  onChange: (next: string) => void;
  symbol: string;
  value: string;
}) {
  const t = useTranslations();
  const converted = decimals === null || value.trim() === "" ? null : toBaseUnits(value, decimals);

  return (
    <Field
      hint={
        decimals === null
          ? t("DashboardMarkets.dvp.fieldAmountHintRaw")
          : converted?.ok === false && converted.reason === "too-precise"
            ? t("DashboardMarkets.dvp.amountTooPrecise", { symbol })
            : converted?.ok
              ? t("DashboardMarkets.dvp.baseUnits", { value: converted.baseUnits })
              : t("DashboardMarkets.dvp.fieldAmountHintDecimals", {
                  symbol,
                  decimals: String(decimals),
                })
      }
      htmlFor={id}
      label={label}
    >
      {/* inputMode, never type="number": these resolve to u64 base units and a
          number input rounds above 2^53. */}
      <Input
        id={id}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        placeholder={decimals === null ? "1000" : "10"}
        required
        value={value}
      />
    </Field>
  );
}

/**
 * The cluster arrives as a prop rather than from `useSolanaCluster` so this
 * form is a pure function of its inputs: it can be rendered, and asserted on,
 * without standing up the whole dashboard workspace context.
 */
export function DvpCreateWorkspace({
  cluster,
  context,
}: {
  cluster: SolanaCluster;
  context: DvpCreateContext;
}) {
  const t = useTranslations();
  const router = useRouter();

  /** Stablecoins deployed on this project's cluster, for the cash leg. */
  const cashOptions = useMemo<DvpCreateOption[]>(
    () =>
      Object.values(WELL_KNOWN_TOKENS)
        .filter((token) => token.isUsdStable)
        .flatMap((token) => {
          const mint = (token.mints as Record<string, { address: string; decimals: number }>)[
            cluster
          ];
          return mint ? [{ mint: mint.address, label: token.symbol, decimals: mint.decimals }] : [];
        }),
    [cluster]
  );

  const [walletId, setWalletId] = useState(context.wallets[0]?.id ?? "");
  const [sdpSide, setSdpSide] = useState<"a" | "b">("a");
  const [counterparty, setCounterparty] = useState("");
  const [assetChoice, setAssetChoice] = useState(context.tokens[0]?.mint ?? CUSTOM);
  const [assetCustom, setAssetCustom] = useState("");
  const [cashChoice, setCashChoice] = useState(cashOptions[0]?.mint ?? CUSTOM);
  const [cashCustom, setCashCustom] = useState("");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [expiry, setExpiry] = useState(defaultExpiry());
  const [refString, setRefString] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assetToken = context.tokens.find((token) => token.mint === assetChoice) ?? null;
  const cashToken = cashOptions.find((token) => token.mint === cashChoice) ?? null;
  const mintA = assetToken?.mint ?? assetCustom.trim();
  const mintB = cashToken?.mint ?? cashCustom.trim();
  const assetSymbol = assetToken?.label ?? t("DashboardMarkets.dvp.sideAsset");
  const cashSymbol = cashToken?.label ?? t("DashboardMarkets.dvp.sideCash");

  const resolvedA = assetToken?.decimals != null ? toBaseUnits(amountA, assetToken.decimals) : null;
  const resolvedB = cashToken?.decimals != null ? toBaseUnits(amountB, cashToken.decimals) : null;
  const baseA = resolvedA ? (resolvedA.ok ? resolvedA.baseUnits : null) : amountA.trim() || null;
  const baseB = resolvedB ? (resolvedB.ok ? resolvedB.baseUnits : null) : amountB.trim() || null;

  const ready = Boolean(walletId && counterparty.trim() && mintA && mintB && baseA && baseB);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!(baseA && baseB)) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/markets/dvp/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // One logical request: a double submit, or a retry after a dropped
          // connection, must not create a second trade at a second address.
          "Idempotency-Key": `dvp-create-${walletId}-${counterparty.trim()}-${baseA}-${baseB}-${expiry}`,
        },
        body: JSON.stringify({
          sdpWalletId: walletId,
          sdpSide,
          counterparty: counterparty.trim(),
          mintA,
          mintB,
          // Every SDP-issued asset is Token-2022. A pasted mint is assumed to
          // be too; if it is not, create refuses and names the mismatch rather
          // than publishing an escrow derived under the wrong program.
          tokenProgramA: TOKEN_2022,
          tokenProgramB: TOKEN_2022,
          amountA: baseA,
          amountB: baseB,
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

  const youDeliver = sdpSide === "a" ? `${amountA} ${assetSymbol}` : `${amountB} ${cashSymbol}`;
  const youReceive = sdpSide === "a" ? `${amountB} ${cashSymbol}` : `${amountA} ${assetSymbol}`;

  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <form className="mx-auto flex w-full max-w-2xl flex-col gap-5" onSubmit={submit}>
        <p className="text-secondary text-sm leading-relaxed">
          {t("DashboardMarkets.dvp.createDescription")}
        </p>

        {context.error ? <Callout variant="danger">{context.error}</Callout> : null}

        <Field
          hint={t("DashboardMarkets.dvp.fieldWalletHint")}
          label={t("DashboardMarkets.dvp.fieldWallet")}
        >
          <Select
            ariaLabel={t("DashboardMarkets.dvp.fieldWallet")}
            onValueChange={(next) => setWalletId(next ?? "")}
            value={walletId}
          >
            {context.wallets.map((wallet) => (
              <SelectItem key={wallet.id} value={wallet.id}>
                {wallet.label ?? wallet.address}
              </SelectItem>
            ))}
          </Select>
        </Field>

        <Field label={t("DashboardMarkets.dvp.fieldSide")}>
          <Select
            ariaLabel={t("DashboardMarkets.dvp.fieldSide")}
            onValueChange={(next) => setSdpSide(next === "b" ? "b" : "a")}
            value={sdpSide}
          >
            <SelectItem value="a">{t("DashboardMarkets.dvp.sideAsset")}</SelectItem>
            <SelectItem value="b">{t("DashboardMarkets.dvp.sideCash")}</SelectItem>
          </Select>
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
          label={t("DashboardMarkets.dvp.fieldAssetMint")}
        >
          {context.tokens.length > 0 ? (
            <Select
              ariaLabel={t("DashboardMarkets.dvp.fieldAssetMint")}
              onValueChange={(next) => setAssetChoice(next ?? CUSTOM)}
              value={assetChoice}
            >
              {context.tokens.map((token) => (
                <SelectItem key={token.mint} value={token.mint}>
                  {token.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>{t("DashboardMarkets.dvp.cashOther")}</SelectItem>
            </Select>
          ) : null}
          {assetChoice === CUSTOM ? (
            <Input
              onChange={(event) => setAssetCustom(event.target.value)}
              placeholder="ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"
              required
              value={assetCustom}
            />
          ) : null}
        </Field>

        <Field
          hint={t("DashboardMarkets.dvp.fieldCashMintHint")}
          label={t("DashboardMarkets.dvp.fieldCashMint")}
        >
          <Select
            ariaLabel={t("DashboardMarkets.dvp.fieldCashMint")}
            onValueChange={(next) => setCashChoice(next ?? CUSTOM)}
            value={cashChoice}
          >
            {cashOptions.map((token) => (
              <SelectItem key={token.mint} value={token.mint}>
                {token.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>{t("DashboardMarkets.dvp.cashOther")}</SelectItem>
          </Select>
          {cashChoice === CUSTOM ? (
            <Input
              onChange={(event) => setCashCustom(event.target.value)}
              placeholder="AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"
              required
              value={cashCustom}
            />
          ) : null}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <AmountField
            decimals={assetToken?.decimals ?? null}
            id="dvp-amount-a"
            label={t("DashboardMarkets.dvp.fieldAmountA")}
            onChange={setAmountA}
            symbol={assetSymbol}
            value={amountA}
          />
          <AmountField
            decimals={cashToken?.decimals ?? null}
            id="dvp-amount-b"
            label={t("DashboardMarkets.dvp.fieldAmountB")}
            onChange={setAmountB}
            symbol={cashSymbol}
            value={amountB}
          />
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

        {/* The trade in words before it is real. A form that moves value in two
            directions at once should say which way each one goes. */}
        <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
          <h2 className="font-medium text-primary text-sm">
            {t("DashboardMarkets.dvp.summaryTitle")}
          </h2>
          {ready ? (
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-tertiary text-xs">
                  {t("DashboardMarkets.dvp.summaryYouDeliver")}
                </dt>
                <dd className="mt-0.5 font-medium text-primary text-sm tabular-nums">
                  {youDeliver}
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-1 text-tertiary text-xs">
                  <ArrowRightIcon aria-hidden className="h-3 w-3" />
                  {t("DashboardMarkets.dvp.summaryYouReceive")}
                </dt>
                <dd className="mt-0.5 font-medium text-primary text-sm tabular-nums">
                  {youReceive}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-tertiary text-xs">
              {t("DashboardMarkets.dvp.summaryIncomplete")}
            </p>
          )}
        </section>

        {error ? (
          <Callout live variant="danger">
            {error}
          </Callout>
        ) : null}

        <div>
          <Button disabled={submitting || !ready} type="submit">
            {submitting
              ? t("DashboardMarkets.dvp.createSubmitting")
              : t("DashboardMarkets.dvp.createAction")}
          </Button>
        </div>
      </form>
    </DashboardWorkspaceOverviewPanel>
  );
}
