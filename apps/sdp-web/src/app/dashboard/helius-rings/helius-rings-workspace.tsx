"use client";

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
import {
  createRingsWallet,
  fetchRingsHealth,
  fetchRingsOperations,
  fetchRingsWallets,
  type RingsHealth,
  type RingsHealthStatus,
  type RingsOperationState,
  type RingsOperationSummary,
  type RingsWallet,
} from "./helius-rings.data";
import { formatWhen } from "./helius-rings.utils";
import { OperationComposer } from "./operation-composer";
import { OperationDetailDrawer } from "./operation-detail-drawer";
import { RecoveryCard } from "./recovery-card";
import { ZonesCard } from "./zones-card";

interface CustodyWalletOption {
  walletId: string;
  label: string | null;
  publicKey: string;
}

const HEALTH_COMPONENTS = ["rpc", "prover", "photon", "gateway"] as const;

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
  const [createNotice, setCreateNotice] = useState<"pending" | "failed" | null>(null);

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

  const handleCreate = useCallback(async () => {
    if (!selectedCustodyWallet || !walletName.trim()) return;
    setCreating(true);
    setCreateNotice(null);
    const result = await createRingsWallet({
      walletId: selectedCustodyWallet,
      name: walletName.trim(),
    });
    setCreating(false);
    if (result.pendingIntegration) {
      setCreateNotice("pending");
    } else if (result.error) {
      setCreateNotice("failed");
    }
    setWalletName("");
    await refresh();
  }, [selectedCustodyWallet, walletName, refresh]);

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
            {HEALTH_COMPONENTS.map((component) => {
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
          {gatewayPending ? (
            <p className="text-sm text-secondary">
              {t("DashboardHeliusRings.health.pendingIntegration")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardHeliusRings.wallets.title")}</CardTitle>
          <CardDescription>{t("DashboardHeliusRings.wallets.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {wallets.length === 0 ? (
            <p className="text-sm text-secondary">{t("DashboardHeliusRings.wallets.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("DashboardHeliusRings.wallets.name")}</TableHead>
                  <TableHead>{t("DashboardHeliusRings.wallets.backingWallet")}</TableHead>
                  <TableHead>{t("DashboardHeliusRings.wallets.shieldedAddress")}</TableHead>
                  <TableHead>{t("DashboardHeliusRings.activity.state")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallets.map((wallet) => (
                  <TableRow key={wallet.id}>
                    <TableCell>{wallet.name}</TableCell>
                    <TableCell>{custodyLabel(wallet.sdpWalletId)}</TableCell>
                    <TableCell>
                      {wallet.shieldedAddress ??
                        t("DashboardHeliusRings.wallets.shieldedAddressPending")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={WALLET_BADGE[wallet.status]}>
                        {t(`DashboardHeliusRings.wallets.status_${wallet.status}`)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {createNotice === "pending" ? (
            <Callout variant="info">
              {t("DashboardHeliusRings.wallets.createPendingNotice")}
            </Callout>
          ) : null}
          {createNotice === "failed" ? (
            <Callout variant="danger">{t("DashboardHeliusRings.wallets.createFailed")}</Callout>
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
