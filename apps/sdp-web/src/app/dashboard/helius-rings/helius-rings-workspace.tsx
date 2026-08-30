"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useCopy } from "@/lib/use-copy";
import {
  createRingsWallet,
  fetchRingsHealth,
  fetchRingsOperations,
  fetchRingsWallets,
  RINGS_HEALTH_COMPONENTS,
  type RingsHealth,
  type RingsHealthStatus,
  type RingsOperationState,
  type RingsOperationSummary,
  type RingsWallet,
} from "./helius-rings.data";
import { formatWhen, healthAlerts, shortenShieldedAddress } from "./helius-rings.utils";
import { OperationComposer } from "./operation-composer";
import { OperationDetailDrawer } from "./operation-detail-drawer";
import { RecoveryCard } from "./recovery-card";
import { ShieldedBalanceCard } from "./shielded-balance-card";
import { WalletIdentityCheck } from "./wallet-identity-check";
import { ZonesCard } from "./zones-card";

interface CustodyWalletOption {
  walletId: string;
  label: string | null;
  publicKey: string;
}

const HEALTH_BADGE: Record<RingsHealthStatus, "success" | "warning" | "danger"> = {
  green: "success",
  amber: "warning",
  red: "danger",
};

const WALLET_BADGE: Record<RingsWallet["status"], "warning" | "success" | "default"> = {
  pending: "warning",
  ready: "success",
  paused: "default",
};

const STATE_BADGE: Record<RingsOperationState, "default" | "success" | "warning" | "danger"> = {
  draft: "default",
  preparing: "default",
  approval_required: "warning",
  proving: "default",
  ready_to_sign: "default",
  submitted: "default",
  indexing: "default",
  completed: "success",
  failed: "danger",
};

export function HeliusRingsWorkspace({
  custodyWallets,
}: {
  custodyWallets: CustodyWalletOption[];
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [health, setHealth] = useState<RingsHealth | null>(null);
  const [wallets, setWallets] = useState<RingsWallet[]>([]);
  const [operations, setOperations] = useState<RingsOperationSummary[]>([]);
  const [detailOperationId, setDetailOperationId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [walletName, setWalletName] = useState("");
  const [selectedCustodyWallet, setSelectedCustodyWallet] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadFailedCopy = t("DashboardHeliusRings.errors.loadFailed");

  const refresh = useCallback(async () => {
    try {
      const [healthResult, walletsResult, operationsResult] = await Promise.all([
        fetchRingsHealth(loadFailedCopy),
        fetchRingsWallets(loadFailedCopy),
        fetchRingsOperations(loadFailedCopy),
      ]);
      setHealth(healthResult.health);
      setWallets(walletsResult.wallets);
      setOperations(operationsResult.operations);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : loadFailedCopy);
    }
  }, [loadFailedCopy]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const gatewayPending = health !== null && health.gateway !== "green";
  const alerts = healthAlerts(health);

  const handleCreate = useCallback(async () => {
    if (!selectedCustodyWallet || !walletName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createRingsWallet({
        walletId: selectedCustodyWallet,
        name: walletName.trim(),
      });
      if (result.wallet) {
        setWalletName("");
        setCreateError(null);
      } else {
        // The server's reason verbatim: it is the only text naming what went wrong.
        setCreateError(result.error ?? t("DashboardHeliusRings.wallets.createFailed"));
      }
    } catch {
      setCreateError(t("DashboardHeliusRings.wallets.createFailed"));
    } finally {
      setCreating(false);
    }
    // The row is reserved before provisioning, so a failure still leaves a
    // pending wallet to show.
    await refresh();
  }, [selectedCustodyWallet, walletName, refresh, t]);

  const custodyLabel = useMemo(() => {
    const byId = new Map(custodyWallets.map((wallet) => [wallet.walletId, wallet]));
    return (sdpWalletId: string) => {
      const wallet = byId.get(sdpWalletId);
      return wallet?.label ?? sdpWalletId;
    };
  }, [custodyWallets]);

  return (
    <div className="flex flex-col gap-6">
      <Callout variant="warning">{t("DashboardHeliusRings.devnetBanner")}</Callout>

      {loadError ? <Callout variant="danger">{loadError}</Callout> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardHeliusRings.health.title")}</CardTitle>
          <CardDescription>{t("DashboardHeliusRings.health.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-4">
            {RINGS_HEALTH_COMPONENTS.map((component) => {
              const status = health?.[component] ?? "red";
              return (
                <div key={component} className="flex items-center gap-2">
                  <span className="text-sm text-secondary">
                    {t(`DashboardHeliusRings.health.component_${component}`)}
                  </span>
                  <Badge variant={HEALTH_BADGE[status]}>
                    {t(`DashboardHeliusRings.health.status_${status}`)}
                  </Badge>
                </div>
              );
            })}
          </div>
          {/* A red badge with no reason is a dead end, so the probe's own
              classification is rendered rather than dropped. */}
          {alerts.map((alert) => (
            <p key={alert.reason} className="text-sm text-secondary">
              {t("DashboardHeliusRings.health.reason", {
                components: alert.components
                  .map((component) => t(`DashboardHeliusRings.health.component_${component}`))
                  .join(", "),
                reason: alert.reason,
              })}
            </p>
          ))}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("DashboardHeliusRings.wallets.title")}</CardTitle>
          <CardDescription>{t("DashboardHeliusRings.wallets.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {wallets.length === 0 ? (
            <p className="text-sm text-secondary">{t("DashboardHeliusRings.wallets.empty")}</p>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <Table className="min-w-0 [&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[18%]">
                      {t("DashboardHeliusRings.wallets.name")}
                    </TableHead>
                    <TableHead className="w-[16%]">
                      {t("DashboardHeliusRings.wallets.backingWallet")}
                    </TableHead>
                    <TableHead className="w-[18%]">
                      {t("DashboardHeliusRings.wallets.shieldedAddress")}
                    </TableHead>
                    <TableHead className="w-[16%]">
                      {t("DashboardHeliusRings.wallets.balance")}
                    </TableHead>
                    <TableHead className="w-[10%]">
                      {t("DashboardHeliusRings.activity.state")}
                    </TableHead>
                    <TableHead className="w-[22%]">
                      {t("DashboardHeliusRings.identity.column")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallets.map((wallet) => (
                    <TableRow key={wallet.id}>
                      <TableCell className="min-w-0">{wallet.name}</TableCell>
                      <TableCell className="min-w-0">{custodyLabel(wallet.sdpWalletId)}</TableCell>
                      <TableCell className="min-w-0">
                        {wallet.shieldedAddress === null ? (
                          t("DashboardHeliusRings.wallets.shieldedAddressPending")
                        ) : (
                          <ShieldedAddress address={wallet.shieldedAddress} />
                        )}
                      </TableCell>
                      <TableCell className="min-w-0 align-top">
                        <ShieldedBalanceCard wallet={wallet} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={WALLET_BADGE[wallet.status]}>
                          {t(`DashboardHeliusRings.wallets.status_${wallet.status}`)}
                        </Badge>
                      </TableCell>
                      {/* Only for a wallet stuck `pending`: a provisioned wallet's
                          identity is re-derived and pinned on every read. */}
                      <TableCell className="min-w-0 align-top">
                        {wallet.status === "pending" ? (
                          <WalletIdentityCheck wallet={wallet} />
                        ) : (
                          t("DashboardHeliusRings.identity.notApplicable")
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {createError ? (
            <Callout variant="danger" live>
              {createError}
            </Callout>
          ) : null}

          {custodyWallets.length === 0 ? (
            <p className="text-sm text-secondary">
              {t("DashboardHeliusRings.wallets.noCustodyWallets")}
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-56 flex-col gap-1.5">
                <span className="text-sm font-medium text-primary">
                  {t("DashboardHeliusRings.wallets.createWalletLabel")}
                </span>
                <Select
                  ariaLabel={t("DashboardHeliusRings.wallets.createWalletLabel")}
                  value={selectedCustodyWallet}
                  onValueChange={setSelectedCustodyWallet}
                  placeholder={t("DashboardHeliusRings.wallets.createWalletPlaceholder")}
                >
                  {custodyWallets.map((wallet) => (
                    <SelectItem key={wallet.walletId} value={wallet.walletId}>
                      {wallet.label ?? wallet.walletId}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="flex min-w-48 flex-col gap-1.5">
                <Label htmlFor="rings-wallet-name">
                  {t("DashboardHeliusRings.wallets.createNameLabel")}
                </Label>
                <Input
                  id="rings-wallet-name"
                  value={walletName}
                  placeholder={t("DashboardHeliusRings.wallets.createNamePlaceholder")}
                  onChange={(event) => setWalletName(event.target.value)}
                />
              </div>
              <Button
                disabled={creating || !selectedCustodyWallet || !walletName.trim()}
                onClick={() => void handleCreate()}
              >
                {creating
                  ? t("DashboardHeliusRings.wallets.creating")
                  : t("DashboardHeliusRings.wallets.create")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <OperationComposer wallets={wallets} gatewayRed={gatewayPending} onPrepared={refresh} />

      <ZonesCard wallets={wallets} />

      <RecoveryCard operations={operations} onChanged={refresh} />

      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardHeliusRings.activity.title")}</CardTitle>
          <CardDescription>{t("DashboardHeliusRings.activity.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {operations.length === 0 ? (
            <p className="text-sm text-secondary">{t("DashboardHeliusRings.activity.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("DashboardHeliusRings.activity.operation")}</TableHead>
                  <TableHead>{t("DashboardHeliusRings.activity.state")}</TableHead>
                  <TableHead>{t("DashboardHeliusRings.activity.amount")}</TableHead>
                  <TableHead>{t("DashboardHeliusRings.activity.created")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operations.map((operation) => (
                  <TableRow
                    key={operation.id}
                    className="cursor-pointer"
                    onClick={() => setDetailOperationId(operation.id)}
                  >
                    <TableCell>
                      {t(`DashboardHeliusRings.activity.opType_${operation.opType}`)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATE_BADGE[operation.state]}>
                        {t(`DashboardHeliusRings.activity.state_${operation.state}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{operation.amountRaw ?? "—"}</TableCell>
                    <TableCell>{formatWhen(operation.createdAt, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <OperationDetailDrawer
        operationId={detailOperationId}
        onClose={() => setDetailOperationId(null)}
      />
    </div>
  );
}

/**
 * Scan-shortened so an 88-char commitment cannot blow the layout; the copy
 * control and `title` still carry the whole string.
 */
function ShieldedAddress({ address }: { address: string }) {
  const t = useTranslations();
  const { copied, copy } = useCopy();
  const label = copied
    ? t("DashboardHeliusRings.wallets.shieldedAddressCopied")
    : t("DashboardHeliusRings.wallets.copyShieldedAddress");

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="font-mono text-sm" title={address}>
        {shortenShieldedAddress(address)}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        title={label}
        onClick={() => void copy(address)}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </span>
  );
}
