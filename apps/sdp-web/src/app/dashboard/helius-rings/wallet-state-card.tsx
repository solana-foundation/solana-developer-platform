"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  type RingsAssetBalance,
  type RingsPrivateHistoryEntry,
  type RingsSyncPhotonResult,
  type RingsWallet,
  type SyncRingsWalletClientResult,
  syncRingsWallet,
} from "./helius-rings.data";
import { formatBaseUnitAmount, formatWhen } from "./helius-rings.utils";

type Translate = ReturnType<typeof useTranslations>;

const ANOMALY_FIELDS = [
  "unparsedTransactions",
  "undecryptableCandidates",
  "unknownAssetIds",
  "unknownAssetFields",
] as const;

function balanceAmount(balance: RingsAssetBalance, locale: string, t: Translate): string {
  const amount =
    formatBaseUnitAmount(balance.amountRaw, balance.decimals, locale) ??
    t("DashboardHeliusRings.walletState.amountUnavailable");
  return t("DashboardHeliusRings.walletState.amountWithSymbol", {
    amount,
    symbol: balance.symbol,
  });
}

function historyAmount(
  entry: RingsPrivateHistoryEntry,
  assetByMint: ReadonlyMap<string, RingsAssetBalance>,
  locale: string,
  t: Translate
): string {
  const asset = assetByMint.get(entry.mint);
  const amount = formatBaseUnitAmount(entry.amountRaw, asset?.decimals ?? 0, locale);
  if (!amount) return t("DashboardHeliusRings.walletState.amountUnavailable");
  return asset
    ? t("DashboardHeliusRings.walletState.amountWithSymbol", {
        amount,
        symbol: asset.symbol,
      })
    : t("DashboardHeliusRings.walletState.amountBaseUnits", { amount });
}

function BalancesTable({ balances }: { balances: RingsAssetBalance[] }) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-primary">
        {t("DashboardHeliusRings.walletState.balancesTitle")}
      </h3>
      {balances.length === 0 ? (
        <p className="text-sm text-secondary">
          {t("DashboardHeliusRings.walletState.balancesEmpty")}
        </p>
      ) : (
        <Table
          aria-label={t("DashboardHeliusRings.walletState.balancesRegionLabel")}
          className="border-y border-border-subtle [&_table]:min-w-[40rem] [&_table]:table-fixed"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-[34%]">
                {t("DashboardHeliusRings.walletState.quantity")}
              </TableHead>
              <TableHead>{t("DashboardHeliusRings.walletState.mint")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {balances.map((balance) => (
              <TableRow key={balance.mint}>
                <TableCell className="text-sm text-primary tabular-nums">
                  {balanceAmount(balance, locale, t)}
                </TableCell>
                <TableCell>
                  <span
                    className="block max-w-80 break-all text-sm text-secondary"
                    title={balance.mint}
                  >
                    {balance.mint}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function HistoryTable({
  balances,
  history,
}: {
  balances: RingsAssetBalance[];
  history: RingsPrivateHistoryEntry[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const assetByMint = useMemo(
    () => new Map(balances.map((balance) => [balance.mint, balance])),
    [balances]
  );

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-primary">
        {t("DashboardHeliusRings.walletState.historyTitle")}
      </h3>
      {history.length === 0 ? (
        <p className="text-sm text-secondary">
          {t("DashboardHeliusRings.walletState.historyEmpty")}
        </p>
      ) : (
        <Table
          aria-label={t("DashboardHeliusRings.walletState.historyRegionLabel")}
          className="border-y border-border-subtle [&_table]:min-w-[52rem] [&_table]:table-fixed"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-[16%]">
                {t("DashboardHeliusRings.walletState.kind")}
              </TableHead>
              <TableHead className="w-[16%]">
                {t("DashboardHeliusRings.walletState.direction")}
              </TableHead>
              <TableHead className="w-[22%]">
                {t("DashboardHeliusRings.walletState.amount")}
              </TableHead>
              <TableHead>{t("DashboardHeliusRings.walletState.slotAndSignature")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((entry) => (
              <TableRow key={`${entry.signature}:${entry.index}`}>
                <TableCell className="text-sm text-primary">
                  {t(`DashboardHeliusRings.walletState.kind_${entry.kind}`)}
                </TableCell>
                <TableCell className="text-sm text-primary">
                  {t(`DashboardHeliusRings.walletState.direction_${entry.direction}`)}
                </TableCell>
                <TableCell className="text-sm text-primary tabular-nums">
                  {historyAmount(entry, assetByMint, locale, t)}
                </TableCell>
                <TableCell>
                  <p className="text-sm text-primary tabular-nums">
                    {t("DashboardHeliusRings.walletState.slot", { slot: entry.slot })}
                  </p>
                  <p
                    className="mt-1 max-w-80 break-all text-sm text-secondary"
                    title={entry.signature}
                  >
                    {entry.signature}
                  </p>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function DegradedWarning({ result }: { result: RingsSyncPhotonResult }) {
  const t = useTranslations();
  const locale = useLocale();
  const anomalies = ANOMALY_FIELDS.filter((field) => result.report[field] > 0);

  return (
    <Callout live title={t("DashboardHeliusRings.walletState.degradedTitle")} variant="warning">
      <p>{t("DashboardHeliusRings.walletState.degradedDescription")}</p>
      {anomalies.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 ps-5">
          {anomalies.map((field) => (
            <li key={field}>
              {t(`DashboardHeliusRings.walletState.anomaly_${field}`, {
                count: result.report[field].toLocaleString(locale),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </Callout>
  );
}

export function WalletStateCard({ wallets }: { wallets: RingsWallet[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const readyWallets = useMemo(
    () => wallets.filter((wallet) => wallet.status === "ready"),
    [wallets]
  );
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const [result, setResult] = useState<RingsSyncPhotonResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestVersion = useRef(0);
  const activeRequest = useRef<number | null>(null);

  const selectedWallet = readyWallets.find((wallet) => wallet.id === selectedWalletId) ?? null;
  const fallbackError = t("DashboardHeliusRings.walletState.errorFallback");

  const changeWallet = useCallback((walletId: string | null) => {
    requestVersion.current += 1;
    activeRequest.current = null;
    setSelectedWalletId(walletId);
    setResult(null);
    setError(null);
    setIsRefreshing(false);
  }, []);

  useEffect(() => {
    if (selectedWalletId && !readyWallets.some((wallet) => wallet.id === selectedWalletId)) {
      changeWallet(null);
    }
  }, [changeWallet, readyWallets, selectedWalletId]);

  useEffect(
    () => () => {
      requestVersion.current += 1;
      activeRequest.current = null;
    },
    []
  );

  const refresh = useCallback(async () => {
    if (!selectedWallet || activeRequest.current !== null) return;

    const requestId = requestVersion.current + 1;
    requestVersion.current = requestId;
    activeRequest.current = requestId;
    setResult(null);
    setError(null);
    setIsRefreshing(true);

    let response: SyncRingsWalletClientResult;
    try {
      response = await syncRingsWallet(selectedWallet.id, fallbackError);
    } catch {
      response = { error: fallbackError };
    }

    if (requestVersion.current !== requestId) return;
    activeRequest.current = null;
    setIsRefreshing(false);
    if ("error" in response) {
      setError(response.error);
      return;
    }
    setResult(response.result);
  }, [fallbackError, selectedWallet]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.walletState.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.walletState.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {readyWallets.length === 0 ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.walletState.noReady")}</p>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-80">
                <span className="text-sm font-medium text-primary">
                  {t("DashboardHeliusRings.walletState.walletLabel")}
                </span>
                <Select
                  ariaLabel={t("DashboardHeliusRings.walletState.walletLabel")}
                  onValueChange={changeWallet}
                  placeholder={t("DashboardHeliusRings.walletState.walletPlaceholder")}
                  value={selectedWalletId}
                >
                  {readyWallets.map((wallet) => (
                    <SelectItem key={wallet.id} value={wallet.id}>
                      {wallet.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <Button
                disabled={!selectedWallet || isRefreshing}
                onClick={() => void refresh()}
                type="button"
              >
                {isRefreshing
                  ? t("DashboardHeliusRings.walletState.refreshing")
                  : t("DashboardHeliusRings.walletState.refresh")}
              </Button>
            </div>

            {isRefreshing && selectedWallet ? (
              <p
                aria-atomic="true"
                className="min-w-0 break-words text-sm text-secondary [overflow-wrap:anywhere]"
                role="status"
              >
                {t("DashboardHeliusRings.walletState.refreshStatus", {
                  walletName: selectedWallet.name,
                })}
              </p>
            ) : !result && !error ? (
              <p
                aria-atomic="true"
                aria-live="polite"
                className="min-w-0 break-words text-sm text-secondary [overflow-wrap:anywhere]"
              >
                {selectedWallet
                  ? t("DashboardHeliusRings.walletState.readyPrompt")
                  : t("DashboardHeliusRings.walletState.selectPrompt")}
              </p>
            ) : null}

            {selectedWallet && error ? (
              <Callout
                live
                title={t("DashboardHeliusRings.walletState.errorTitle")}
                variant="danger"
              >
                <div className="flex flex-col items-start gap-3">
                  <p className="break-words">{error}</p>
                  <Button onClick={() => void refresh()} type="button" variant="secondary">
                    {t("DashboardHeliusRings.walletState.retry")}
                  </Button>
                </div>
              </Callout>
            ) : null}

            {selectedWallet && result ? (
              <div className="flex flex-col gap-5">
                <p className="text-sm text-secondary" role="status">
                  {t("DashboardHeliusRings.walletState.observedAt", {
                    time: formatWhen(result.observedAt, locale),
                  })}
                </p>
                {result.report.degraded ? <DegradedWarning result={result} /> : null}
                <BalancesTable balances={result.balances} />
                <HistoryTable balances={result.balances} history={result.history} />
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
