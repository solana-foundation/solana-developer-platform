"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { createRingsWallet, type RingsWallet } from "./helius-rings.data";
import { shortenShieldedAddress } from "./helius-rings.utils";
import { ShieldedBalanceCard } from "./shielded-balance-card";
import { WalletIdentityCheck } from "./wallet-identity-check";

const WALLET_BADGE: Record<RingsWallet["status"], "warning" | "success" | "default"> = {
  pending: "warning",
  ready: "success",
  paused: "default",
};

export interface CustodyWalletOption {
  walletId: string;
  label: string | null;
  publicKey: string;
}

/**
 * Private wallets card: the create form, the wallets table, and row selection.
 * Owns its own create-form state; the parent only supplies the wallet list and
 * an `onCreated` callback to refresh.
 */
export function PrivateWalletsCard({
  wallets,
  custodyWallets,
  availableCustodyWallets,
  selectedWalletId,
  onSelect,
  balancesTick,
  onCreated,
}: {
  wallets: readonly RingsWallet[];
  custodyWallets: readonly CustodyWalletOption[];
  availableCustodyWallets: readonly CustodyWalletOption[];
  selectedWalletId: string | null;
  onSelect: (walletId: string) => void;
  balancesTick: number;
  onCreated: () => Promise<void>;
}) {
  const t = useTranslations();

  const [walletName, setWalletName] = useState("");
  const [selectedCustodyWallet, setSelectedCustodyWallet] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const custodyLabel = useMemo(() => {
    const byId = new Map(custodyWallets.map((wallet) => [wallet.walletId, wallet]));
    return (sdpWalletId: string) => byId.get(sdpWalletId)?.label ?? sdpWalletId;
  }, [custodyWallets]);

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
        setCreateError(result.error ?? t("DashboardHeliusRings.wallets.createFailed"));
      }
    } catch {
      setCreateError(t("DashboardHeliusRings.wallets.createFailed"));
    } finally {
      setCreating(false);
    }
    await onCreated();
  }, [selectedCustodyWallet, walletName, onCreated, t]);

  return (
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
                {wallets.map((wallet) => (
                  <PrivateWalletRow
                    key={wallet.id}
                    wallet={wallet}
                    selected={wallet.id === selectedWalletId}
                    custodyName={custodyLabel(wallet.sdpWalletId)}
                    onSelect={() => onSelect(wallet.id)}
                    balancesTick={balancesTick}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PrivateWalletRow({
  wallet,
  selected,
  custodyName,
  onSelect,
  balancesTick,
}: {
  wallet: RingsWallet;
  selected: boolean;
  custodyName: string;
  onSelect: () => void;
  balancesTick: number;
}) {
  const t = useTranslations();
  return (
    <TableRow
      aria-selected={selected}
      onClick={onSelect}
      className={
        selected
          ? "cursor-pointer border-l-2 border-info bg-info-bg"
          : "cursor-pointer border-l-2 border-transparent hover:bg-fill-subtle"
      }
    >
      <TableCell className="min-w-0">{wallet.name}</TableCell>
      <TableCell className="min-w-0">{custodyName}</TableCell>
      <TableCell className="min-w-0 align-top">
        {wallet.shieldedAddress === null ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-secondary">
              {t("DashboardHeliusRings.wallets.shieldedAddressPending")}
            </span>
            {wallet.status === "pending" ? <WalletIdentityCheck wallet={wallet} /> : null}
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
}

/** Scan-shortened; the copy control and `title` still carry the whole string. */
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
