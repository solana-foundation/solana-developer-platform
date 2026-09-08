"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/i18n/provider";
import { ActivityCard } from "./activity-card";
import { RingsConfigurationCard } from "./configuration-card";
import { HealthStrip } from "./health-strip";
import {
  executeRingsOperation,
  fetchProjectRings,
  fetchRingsHealth,
  fetchRingsOperations,
  fetchRingsWallets,
  type ProjectRing,
  RINGS_HEALTH_COMPONENTS,
  type RingsHealth,
  type RingsOperationSummary,
  type RingsWallet,
} from "./helius-rings.data";
import { healthAlerts, isSettling } from "./helius-rings.utils";
import { fetchRingsSetupStatus, type RingsSetupStatus } from "./helius-rings-configuration.data";
import { OperationComposer } from "./operation-composer";
import { OperationDetailDrawer } from "./operation-detail-drawer";
import { type CustodyWalletOption, PrivateWalletsCard } from "./private-wallets-card";
import { RingCard } from "./ring-card";
import { WalletOverview } from "./wallet-overview";

/** How often to re-read while an operation is still moving. */
const OPERATION_POLL_INTERVAL_MS = 4_000;

export function HeliusRingsWorkspace({
  custodyWallets,
}: {
  custodyWallets: CustodyWalletOption[];
}) {
  const t = useTranslations();

  const [health, setHealth] = useState<RingsHealth | null>(null);
  const [setup, setSetup] = useState<RingsSetupStatus | null>(null);
  const [wallets, setWallets] = useState<RingsWallet[]>([]);
  const [operations, setOperations] = useState<RingsOperationSummary[]>([]);
  const [projectRings, setProjectRings] = useState<ProjectRing[]>([]);
  const [detailOperationId, setDetailOperationId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);

  const loadFailedCopy = t("DashboardHeliusRings.errors.loadFailed");

  const refresh = useCallback(async () => {
    try {
      const setupResult = await fetchRingsSetupStatus();
      setSetup(setupResult);
      if (!setupResult.configured) {
        setHealth(null);
        setWallets([]);
        setOperations([]);
        setLoadError(null);
        return;
      }
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

  // Rings live outside `refresh` on purpose: the settling poll below re-runs
  // `refresh` every 4s, and the near-static ring rows only change through the
  // ring card, which refreshes them itself.
  const refreshRings = useCallback(async () => {
    try {
      const { rings } = await fetchProjectRings(loadFailedCopy);
      setProjectRings(rings);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : loadFailedCopy);
    }
  }, [loadFailedCopy]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshRings()]);
  }, [refresh, refreshRings]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

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

  // Kept fresh through `tickRef` so the interval effect below doesn't
  // re-subscribe every time `operations`/`refresh` change; only the toggle
  // between settling/idle re-arms it. The ref is written inside an effect,
  // not during render, to keep the render pass pure.
  const tickRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    tickRef.current = async () => {
      if (ticking.current) return;
      ticking.current = true;
      try {
        // Settlement is otherwise driven only by the sweep, so a completed
        // transaction shows as `indexing` until the next minute boundary. Asking
        // here makes the row track Photon instead of the cron.
        //
        // Only `indexing`: the endpoint reads Photon and completes from what it
        // finds, whereas for a row still waiting on custody the same call
        // concludes that signing died and fails it. Single-pass loop avoids the
        // `.filter().map()` two-pass over the same list.
        const pending: Promise<unknown>[] = [];
        for (const operation of operations) {
          if (operation.state !== "indexing") continue;
          pending.push(executeRingsOperation(operation.id).catch(() => undefined));
        }
        await Promise.all(pending);
        await refresh();
      } finally {
        ticking.current = false;
      }
    };
  }, [operations, refresh]);

  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void tickRef.current(), OPERATION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [settling]);

  // Any upstream red — the composer surfaces a heads-up so the operator isn't
  // surprised when the pipeline stops mid-flight on that upstream.
  const upstreamsRed =
    health !== null && RINGS_HEALTH_COMPONENTS.some((component) => health[component] === "red");
  const alerts = healthAlerts(health);

  const custodyByWalletId = useMemo(
    () => new Map(custodyWallets.map((wallet) => [wallet.walletId, wallet])),
    [custodyWallets]
  );

  // One custody wallet = one private wallet. Anything already bound (including a
  // pending row: it holds the slot too) drops out of the create form.
  const availableCustodyWallets = useMemo(() => {
    const boundIds = new Set(wallets.map((wallet) => wallet.sdpWalletId));
    return custodyWallets.filter((wallet) => !boundIds.has(wallet.walletId));
  }, [custodyWallets, wallets]);

  // Derive the effective selection rather than reconcile a stored id in an
  // effect: falls back to the sole wallet when nothing is selected or when the
  // stored id no longer resolves. No paint frame with stale state.
  const selectedWallet =
    wallets.find((wallet) => wallet.id === selectedWalletId) ??
    (wallets.length === 1 ? wallets[0] : null);

  const filteredOperations = useMemo(
    () =>
      selectedWallet === null
        ? []
        : operations.filter((operation) => operation.walletId === selectedWallet.id),
    [operations, selectedWallet]
  );

  return (
    <div className="flex flex-col gap-6">
      <Callout variant="warning">{t("DashboardHeliusRings.devnetBanner")}</Callout>

      {loadError ? <Callout variant="danger">{loadError}</Callout> : null}

      {setup === null ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-secondary">
            {t("DashboardHeliusRings.setup.loading")}
          </CardContent>
        </Card>
      ) : setup.source !== "database" ? (
        <RingsConfigurationCard setup={setup} onConfigured={refresh} />
      ) : null}

      {setup?.configured ? (
        <>
          <HealthStrip health={health} alerts={alerts} />

          <RingCard rings={projectRings} onChanged={refreshAll} />

          <PrivateWalletsCard
            wallets={wallets}
            custodyWallets={custodyWallets}
            availableCustodyWallets={availableCustodyWallets}
            selectedWalletId={selectedWallet?.id ?? null}
            onSelect={setSelectedWalletId}
            balancesTick={balancesTick}
            onCreated={refresh}
          />

          {selectedWallet === null ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-secondary">
                {t("DashboardHeliusRings.workspace.selectPrompt")}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <WalletOverview
                  wallet={selectedWallet}
                  refreshTick={balancesTick}
                  projectRings={projectRings}
                />
                <OperationComposer
                  key={selectedWallet.id}
                  wallet={selectedWallet}
                  recipientOptions={wallets.filter(
                    (wallet) => wallet.id !== selectedWallet.id && wallet.shieldedAddress !== null
                  )}
                  custodyPublicKey={
                    custodyByWalletId.get(selectedWallet.sdpWalletId)?.publicKey ?? null
                  }
                  projectRings={projectRings}
                  gatewayRed={upstreamsRed}
                  onPrepared={refresh}
                />
              </div>

              <ActivityCard
                operations={filteredOperations}
                projectRings={projectRings}
                onChanged={refresh}
                onSelect={setDetailOperationId}
              />
            </>
          )}

          <OperationDetailDrawer
            operationId={detailOperationId}
            onClose={() => setDetailOperationId(null)}
          />
        </>
      ) : null}
    </div>
  );
}
