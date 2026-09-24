"use client";

import type { CustodyWalletSummary, PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import type { WalletChannelBalance } from "../private-channels-page.data";
import { deleteVerifiedWalletAction, verifyWalletAction } from "./actions";

interface Props {
  /**
   * The project this table's data was rendered under; verify and revoke submit
   * bound to it rather than re-reading the mutable selection cookie.
   */
  projectId: string;
  verifiedWallets: PrivateChannelVerifiedWalletDto[];
  custodyWallets: CustodyWalletSummary[];
  /** Keyed by wallet pubkey; entry present when the balance read succeeded. */
  channelBalances: Record<string, WalletChannelBalance>;
  loadError: boolean;
  /** Detail pages manage enrollment, not balances. */
  showBalance?: boolean;
  /** Optional id used by a page-level action to open the enrollment form. */
  enrollTriggerId?: string;
}

function shortKey(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

type Translate = ReturnType<typeof useTranslations>;

/** Channel balance for a wallet, or a dash when the gateway read is unavailable. */
function balanceLabel(t: Translate, balance: WalletChannelBalance | undefined): string {
  if (!balance) return t("DashboardPrivateChannels.overview.valueNone");
  const known = WELL_KNOWN_TOKEN_BY_MINT.get(balance.mint);
  const symbol = known?.symbol ?? shortKey(balance.mint);
  return t("DashboardPrivateChannels.verifiedWallets.channelBalanceAmount", {
    amount: balance.uiAmount,
    symbol,
  });
}

function WalletBalanceCell({
  showBalance,
  t,
  balance,
}: {
  showBalance: boolean;
  t: Translate;
  balance: WalletChannelBalance | undefined;
}) {
  if (!showBalance) return null;
  return <TableCell className="text-secondary tabular-nums">{balanceLabel(t, balance)}</TableCell>;
}

function VerifiedWalletRow({
  verified,
  wallet,
  showBalance,
  t,
  balance,
  busy,
  onRevoke,
}: {
  verified: PrivateChannelVerifiedWalletDto;
  /** Matched custody wallet, or undefined when the row is orphaned. */
  wallet: CustodyWalletSummary | undefined;
  showBalance: boolean;
  t: Translate;
  balance: WalletChannelBalance | undefined;
  busy: boolean;
  onRevoke: (pubkey: string) => void;
}) {
  return (
    <TableRow key={verified.id}>
      <TableCell>
        <span className="flex min-w-0 items-center gap-3">
          {wallet?.provider && isKnownCustodyProvider(wallet.provider) ? (
            <WalletProviderMark provider={wallet.provider} size="sm" />
          ) : null}
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">
              {wallet
                ? (wallet.label ?? formatCustodyProviderName(wallet.provider ?? "wallet"))
                : shortKey(verified.pubkey)}
            </span>
            <span className="truncate text-xs text-secondary">
              {wallet
                ? shortKey(wallet.publicKey)
                : t("DashboardPrivateChannels.verifiedWallets.orphaned")}
            </span>
          </span>
        </span>
      </TableCell>
      <WalletBalanceCell showBalance={showBalance} t={t} balance={balance} />
      <TableCell align="right">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("DashboardPrivateChannels.verifiedWallets.revokeAria", {
            pubkey: verified.pubkey,
          })}
          title={t("DashboardPrivateChannels.verifiedWallets.revokeTitle")}
          disabled={busy}
          onClick={() => onRevoke(verified.pubkey)}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function VerifiedWalletsContent({
  t,
  loadError,
  custodyEnabled,
  showBalance,
  custodyWallets,
  verifiedWallets,
  channelBalances,
  custodyByPubkey,
  pending,
  pendingKey,
  onRevoke,
}: {
  t: Translate;
  loadError: boolean;
  custodyEnabled: boolean;
  showBalance: boolean;
  custodyWallets: CustodyWalletSummary[];
  verifiedWallets: PrivateChannelVerifiedWalletDto[];
  channelBalances: Record<string, WalletChannelBalance>;
  custodyByPubkey: Map<string, CustodyWalletSummary>;
  pending: boolean;
  /** Pubkey of the row whose mutation is in flight. */
  pendingKey: string | null;
  onRevoke: (pubkey: string) => void;
}) {
  if (loadError) {
    return (
      <p className="text-sm text-error">
        {t("DashboardPrivateChannels.verifiedWallets.loadError")}
      </p>
    );
  }
  if (custodyWallets.length === 0 && verifiedWallets.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-secondary">
          {t("DashboardPrivateChannels.verifiedWallets.noWallets")}
        </p>
        {custodyEnabled ? (
          <Button asChild>
            <Link href="/dashboard/wallets">
              {t("DashboardPrivateChannels.verifiedWallets.createWallet")}
            </Link>
          </Button>
        ) : null}
      </div>
    );
  }
  if (verifiedWallets.length === 0) {
    return (
      <p className="text-sm text-secondary">
        {t("DashboardPrivateChannels.verifiedWallets.empty")}
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("DashboardPrivateChannels.overview.colWallet")}</TableHead>
          {showBalance ? (
            <TableHead>{t("DashboardPrivateChannels.overview.colBalance")}</TableHead>
          ) : null}
          <TableHead align="right"> </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {verifiedWallets.map((verified) => (
          <VerifiedWalletRow
            key={verified.id}
            verified={verified}
            wallet={custodyByPubkey.get(verified.pubkey)}
            showBalance={showBalance}
            t={t}
            balance={channelBalances[verified.pubkey]}
            busy={pending && pendingKey === verified.pubkey}
            onRevoke={onRevoke}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function EnrollWalletModal({
  t,
  isOpen,
  onClose,
  pending,
  availableWallets,
  selectedWalletId,
  onSelectWallet,
  onSubmit,
}: {
  t: Translate;
  isOpen: boolean;
  onClose: () => void;
  pending: boolean;
  availableWallets: CustodyWalletSummary[];
  selectedWalletId: string | null;
  onSelectWallet: (walletId: string | null) => void;
  onSubmit: (walletId: string, pubkey: string) => void;
}) {
  const selectedWallet = availableWallets.find((wallet) => wallet.walletId === selectedWalletId);
  return (
    <Modal
      isOpen={isOpen}
      ariaLabel={t("DashboardPrivateChannels.verifiedWallets.enroll")}
      onClose={onClose}
      closeDisabled={pending}
      size="sm"
    >
      <form
        action={() => {
          if (selectedWallet) onSubmit(selectedWallet.walletId, selectedWallet.publicKey);
        }}
        className="space-y-6 p-6"
      >
        <div className="space-y-2 pr-8">
          <h2 className="text-xl font-medium text-primary">
            {t("DashboardPrivateChannels.verifiedWallets.enroll")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.verifiedWallets.enrollDescription")}
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-primary">
            {t("DashboardPrivateChannels.verifiedWallets.walletLabel")}
          </p>
          <Select
            ariaLabel={t("DashboardPrivateChannels.verifiedWallets.walletLabel")}
            value={selectedWalletId}
            onValueChange={onSelectWallet}
            placeholder={t("DashboardPrivateChannels.verifiedWallets.walletPlaceholder")}
            disabled={pending}
          >
            {availableWallets.map((wallet) => (
              <SelectItem key={wallet.walletId} value={wallet.walletId}>
                {wallet.label ?? formatCustodyProviderName(wallet.provider ?? "wallet")} ·{" "}
                {shortKey(wallet.publicKey)}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            {t("DashboardPrivateChannels.common.cancel")}
          </Button>
          <Button
            type="submit"
            className="w-44 whitespace-nowrap"
            disabled={!selectedWallet || pending}
            iconLeft={
              pending ? <Loader2Icon className="size-4 shrink-0 animate-spin" /> : undefined
            }
          >
            {pending
              ? t("DashboardPrivateChannels.verifiedWallets.enrolling")
              : t("DashboardPrivateChannels.verifiedWallets.enroll")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function WalletsTable({
  projectId,
  verifiedWallets,
  custodyWallets,
  channelBalances,
  loadError,
  showBalance = true,
  enrollTriggerId,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const t = useTranslations();
  const workspace = useOptionalDashboardWorkspace();
  const custodyEnabled = workspace?.flags.custody ?? true;

  const verifiedPubkeys = new Set(verifiedWallets.map((w) => w.pubkey));
  const availableWallets = custodyWallets.filter(
    (wallet) => !verifiedPubkeys.has(wallet.publicKey)
  );

  function handleVerify(walletId: string, pubkey: string) {
    setPendingKey(walletId);
    startTransition(async () => {
      const result = await verifyWalletAction({ walletId, projectId });
      if (result.ok) {
        toast.success(
          t("DashboardPrivateChannels.verifiedWallets.verifySuccess", { key: shortKey(pubkey) })
        );
        setEnrollOpen(false);
        setSelectedWalletId(null);
      } else {
        toast.error(result.message);
      }
      setPendingKey(null);
    });
  }

  function openEnrollment() {
    setSelectedWalletId(null);
    setEnrollOpen(true);
  }

  function handleDelete(pubkey: string) {
    setPendingKey(pubkey);
    startTransition(async () => {
      const result = await deleteVerifiedWalletAction({ pubkey, projectId });
      if (result.ok) {
        toast.success(
          t("DashboardPrivateChannels.verifiedWallets.revokeSuccess", { key: shortKey(pubkey) })
        );
      } else {
        toast.error(result.message);
      }
      setPendingKey(null);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.walletsTitle")}</CardTitle>
        {availableWallets.length > 0 ? (
          <CardAction>
            <Button id={enrollTriggerId} disabled={pending} onClick={openEnrollment}>
              {t("DashboardPrivateChannels.verifiedWallets.enroll")}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <VerifiedWalletsContent
          t={t}
          loadError={loadError}
          custodyEnabled={custodyEnabled}
          showBalance={showBalance}
          custodyWallets={custodyWallets}
          verifiedWallets={verifiedWallets}
          channelBalances={channelBalances}
          custodyByPubkey={new Map(custodyWallets.map((w) => [w.publicKey, w]))}
          pending={pending}
          pendingKey={pendingKey}
          onRevoke={handleDelete}
        />
      </CardContent>
      <EnrollWalletModal
        t={t}
        isOpen={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        pending={pending}
        availableWallets={availableWallets}
        selectedWalletId={selectedWalletId}
        onSelectWallet={setSelectedWalletId}
        onSubmit={handleVerify}
      />
    </Card>
  );
}
