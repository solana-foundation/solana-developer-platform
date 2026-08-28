"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { ActivityCard } from "./activity-card";
import {
  createRingsWallet,
  executeRingsOperation,
  fetchRingsHealth,
  fetchRingsOperations,
  fetchRingsWallets,
  RINGS_HEALTH_COMPONENTS,
  type RingsHealth,
  type RingsHealthStatus,
  type RingsOperationSummary,
  type RingsWallet,
} from "./helius-rings.data";
import { healthAlerts, isSettling, shortenShieldedAddress } from "./helius-rings.utils";
import { OperationComposer } from "./operation-composer";
import { OperationDetailDrawer } from "./operation-detail-drawer";
import { ShieldedBalanceCard } from "./shielded-balance-card";
import { WalletIdentityCheck } from "./wallet-identity-check";
import { WalletOverview } from "./wallet-overview";

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

/** How often to re-read while an operation is still moving. */
const OPERATION_POLL_INTERVAL_MS = 4_000;

export function HeliusRingsWorkspace({
  custodyWallets,
}: {
  custodyWallets: CustodyWalletOption[];
}) {
  const t = useTranslations();

  const [health, setHealth] = useState<RingsHealth | null>(null);
  const [wallets, setWallets] = useState<RingsWallet[]>([]);
  const [operations, setOperations] = useState<RingsOperationSummary[]>([]);
  const [detailOperationId, setDetailOperationId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [walletName, setWalletName] = useState("");
  const [selectedCustodyWallet, setSelectedCustodyWallet] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);

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

  // Bumped whenever a new operation transitions to completed on our watch, so
  // the balance surfaces re-sync and the just-landed value is on screen without
  // an explicit refresh.
  const [balancesTick, setBalancesTick] = useState(0);
  const completedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    let discoveredCompletion = false;
    for (const operation of operations) {
      if (operation.state !== "completed") continue;
      if (completedIds.current.has(operation.id)) continue;
      completedIds.current.add(operation.id);
      discoveredCompletion = true;
    }
    if (discoveredCompletion) setBalancesTick((current) => current + 1);
  }, [operations]);

  // Signing and submission finish inline, but indexing is settled by a
  // once-a-minute sweep, so an operation routinely lands here mid-flight and
  // then changes with nothing on the page having asked. Polling stops as soon
  // as nothing is moving, so an idle dashboard is not one.
  const settling = operations.some((operation) => isSettling(operation.state));

  // A tick outlasting the interval would otherwise stack another on top of it.
  const ticking = useRef(false);

  const tick = useCallback(async () => {
    if (ticking.current) return;
    ticking.current = true;
    try {
      // Settlement is otherwise driven only by the sweep, so a completed
      // transaction shows as `indexing` until the next minute boundary. Asking
      // here makes the row track Photon instead of the cron.
      //
      // Only `indexing`: the endpoint reads Photon and completes from what it
      // finds, whereas for a row still waiting on custody the same call
      // concludes that signing died and fails it.
      await Promise.all(
        operations
          .filter((operation) => operation.state === "indexing")
          .map((operation) => executeRingsOperation(operation.id).catch(() => undefined))
      );
      await refresh();
    } finally {
      ticking.current = false;
    }
  }, [operations, refresh]);

  // A successful refresh replaces `tick` and so restarts the interval, spacing
  // the next one a full period after the last finished. A failed one leaves
  // both in place, which is what keeps polling alive across a blip.
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void tick(), OPERATION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [settling, tick]);

  // Any upstream red — the composer surfaces a heads-up so the operator isn't
  // surprised when the pipeline stops mid-flight on that upstream.
  const upstreamsRed =
    health !== null && RINGS_HEALTH_COMPONENTS.some((component) => health[component] === "red");
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

  const custodyByWalletId = useMemo(
    () => new Map(custodyWallets.map((wallet) => [wallet.walletId, wallet])),
    [custodyWallets]
  );

  const custodyLabel = useCallback(
    (sdpWalletId: string) => custodyByWalletId.get(sdpWalletId)?.label ?? sdpWalletId,
    [custodyByWalletId]
  );

  // One custody wallet = one private wallet. Anything already bound (including a
  // pending row: it holds the slot too) drops out of the create form.
  const availableCustodyWallets = useMemo(() => {
    const boundIds = new Set(wallets.map((wallet) => wallet.sdpWalletId));
    return custodyWallets.filter((wallet) => !boundIds.has(wallet.walletId));
  }, [custodyWallets, wallets]);

  // Keep the selection valid: auto-select the sole wallet, clear if it vanishes.
  useEffect(() => {
    if (wallets.length === 0) {
      if (selectedWalletId !== null) setSelectedWalletId(null);
      return;
    }
    const stillPresent = wallets.some((wallet) => wallet.id === selectedWalletId);
    if (!stillPresent) setSelectedWalletId(wallets.length === 1 ? wallets[0].id : null);
  }, [wallets, selectedWalletId]);

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === selectedWalletId) ?? null,
    [wallets, selectedWalletId]
  );

  const filteredOperations = useMemo(
    () =>
      selectedWalletId === null
        ? []
        : operations.filter((operation) => operation.walletId === selectedWalletId),
    [operations, selectedWalletId]
  );

  return (
    <div className="flex flex-col gap-6">
      <Callout variant="warning">{t("DashboardHeliusRings.devnetBanner")}</Callout>

      {loadError ? <Callout variant="danger">{loadError}</Callout> : null}

      {/* Compact strip, not a full Card: one line of dot + label per component. */}
      <div className="rounded-[var(--sdp-surface-radius)] bg-surface-raised px-4 py-2.5 shadow-sm ring-1 ring-border-default">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          <span className="font-medium text-primary">
            {t("DashboardHeliusRings.health.title")}
          </span>
          {RINGS_HEALTH_COMPONENTS.map((component) => {
            const status = health?.[component] ?? "red";
            const label = t(`DashboardHeliusRings.health.component_${component}`);
            return (
              <div key={component} className="flex items-center gap-2">
                {/* Green reads as "fine, nothing to say"; anything else needs
                    the status word to name the failure. */}
                {status === "green" ? (
                  <>
                    <span aria-hidden="true" className="size-2 rounded-full bg-success" />
                    <span className="text-secondary">{label}</span>
                  </>
                ) : (
                  <>
                    <span className="text-secondary">{label}</span>
                    <Badge variant={HEALTH_BADGE[status]}>
                      {t(`DashboardHeliusRings.health.status_${status}`)}
                    </Badge>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {alerts.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1">
            {alerts.map((alert) => (
              <p key={alert.reason} className="text-xs text-secondary">
                {t("DashboardHeliusRings.health.reason", {
                  components: alert.components
                    .map((component) => t(`DashboardHeliusRings.health.component_${component}`))
                    .join(", "),
                  reason: alert.reason,
                })}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("DashboardHeliusRings.wallets.title")}</CardTitle>
          <CardDescription>{t("DashboardHeliusRings.wallets.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {createError ? (
            <Callout variant="danger" live>
              {createError}
            </Callout>
          ) : null}

          {custodyWallets.length === 0 ? (
            <p className="text-sm text-secondary">
              {t("DashboardHeliusRings.wallets.noCustodyWallets")}
            </p>
          ) : availableCustodyWallets.length === 0 ? (
            <p className="text-sm text-secondary">
              {t("DashboardHeliusRings.wallets.allCustodyWalletsBound")}
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
                  {availableCustodyWallets.map((wallet) => (
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

          <hr className="border-border-default" role="presentation" />

          {wallets.length === 0 ? (
            <p className="text-sm text-secondary">{t("DashboardHeliusRings.wallets.empty")}</p>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <Table className="min-w-0 [&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[22%]">
                      {t("DashboardHeliusRings.wallets.name")}
                    </TableHead>
                    <TableHead className="w-[20%]">
                      {t("DashboardHeliusRings.wallets.backingWallet")}
                    </TableHead>
                    <TableHead className="w-[22%]">
                      {t("DashboardHeliusRings.wallets.shieldedAddress")}
                    </TableHead>
                    <TableHead className="w-[22%]">
                      {t("DashboardHeliusRings.wallets.balance")}
                    </TableHead>
                    <TableHead className="w-[14%]">
                      {t("DashboardHeliusRings.activity.state")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallets.map((wallet) => {
                    const selected = wallet.id === selectedWalletId;
                    return (
                      <TableRow
                        key={wallet.id}
                        aria-selected={selected}
                        onClick={() => setSelectedWalletId(wallet.id)}
                        className={
                          selected
                            ? "cursor-pointer border-l-2 border-info bg-info-bg"
                            : "cursor-pointer border-l-2 border-transparent hover:bg-fill-subtle"
                        }
                      >
                        <TableCell className="min-w-0">{wallet.name}</TableCell>
                        <TableCell className="min-w-0">
                          {custodyLabel(wallet.sdpWalletId)}
                        </TableCell>
                        <TableCell className="min-w-0 align-top">
                          {wallet.shieldedAddress === null ? (
                            // A stuck-pending row is the one case the identity
                            // check helps with: the button sits under the empty
                            // address so the diagnosis is where the problem is.
                            <div className="flex flex-col gap-1.5">
                              <span className="text-sm text-secondary">
                                {t("DashboardHeliusRings.wallets.shieldedAddressPending")}
                              </span>
                              {wallet.status === "pending" ? (
                                <WalletIdentityCheck wallet={wallet} />
                              ) : null}
                            </div>
                          ) : (
                            <ShieldedAddress address={wallet.shieldedAddress} />
                          )}
                        </TableCell>
                        <TableCell className="min-w-0 align-top">
                          <ShieldedBalanceCard wallet={wallet} refreshTick={balancesTick} />
                        </TableCell>
                        <TableCell>
                          <Badge variant={WALLET_BADGE[wallet.status]}>
                            {t(`DashboardHeliusRings.wallets.status_${wallet.status}`)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedWallet === null ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-secondary">
            {t("DashboardHeliusRings.workspace.selectPrompt")}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <WalletOverview wallet={selectedWallet} refreshTick={balancesTick} />
            <OperationComposer
              wallets={[selectedWallet]}
              recipientOptions={wallets.filter(
                (wallet) => wallet.id !== selectedWallet.id && wallet.shieldedAddress !== null
              )}
              custody={(() => {
                const custody = custodyByWalletId.get(selectedWallet.sdpWalletId);
                if (!custody) return null;
                return {
                  name: custody.label ?? custody.walletId,
                  publicKey: custody.publicKey,
                };
              })()}
              gatewayRed={upstreamsRed}
              onPrepared={refresh}
            />
          </div>

          <ActivityCard
            operations={filteredOperations}
            onChanged={refresh}
            onSelect={setDetailOperationId}
          />
        </>
      )}

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
