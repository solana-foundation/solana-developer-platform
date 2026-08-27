"use client";

import {
  type CustodyWalletSummary,
  type PrivateChannelDeposit,
  privateChannelTokens,
} from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useReducer, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { AmountField } from "../amount-field";
import { getAmountError } from "../amount-validation";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "../private-channels-routes";
import { fetchWalletBalancesAction, type WalletBalanceView } from "../wallet-balances";
import { createDepositAction } from "./actions";
import { DepositProgress } from "./deposit-progress";

function walletLabel(wallet: CustodyWalletSummary): string {
  const short = `${wallet.publicKey.slice(0, 4)}…${wallet.publicKey.slice(-4)}`;
  return wallet.label ? `${wallet.label} (${short})` : short;
}

interface DepositFormState {
  walletId: string;
  mint: string;
  amount: string;
  showAmountError: boolean;
  recipient: string;
  error: string | null;
  deposit: PrivateChannelDeposit | null;
  balances: WalletBalanceView;
  refetchKey: number;
}

type DepositFormUpdate =
  | Partial<DepositFormState>
  | ((state: DepositFormState) => Partial<DepositFormState>);

function depositFormReducer(state: DepositFormState, update: DepositFormUpdate): DepositFormState {
  const patch = typeof update === "function" ? update(state) : update;
  return { ...state, ...patch };
}

export function DepositForm({ wallets }: { wallets: CustodyWalletSummary[] }) {
  const tokens = privateChannelTokens(useSolanaCluster());
  const [state, updateState] = useReducer(depositFormReducer, {
    walletId: wallets[0]?.walletId ?? "",
    mint: tokens[0]?.mint ?? "",
    amount: "",
    showAmountError: false,
    recipient: "",
    error: null,
    deposit: null,
    balances: { channel: null, onChain: null },
    refetchKey: 0,
  });
  const [isSubmitting, startTransition] = useTransition();
  const t = useTranslations();
  const {
    walletId,
    mint,
    amount,
    showAmountError,
    recipient,
    error,
    deposit,
    balances,
    refetchKey,
  } = state;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchKey is the refetch trigger, not a value read in the effect.
  useEffect(() => {
    if (!walletId) {
      updateState({ balances: { channel: null, onChain: null } });
      return;
    }
    let active = true;
    updateState({ balances: { channel: null, onChain: null } });
    fetchWalletBalancesAction(walletId, mint || undefined).then((result) => {
      if (active) updateState({ balances: result });
    });
    return () => {
      active = false;
    };
  }, [walletId, mint, refetchKey]);

  if (deposit) {
    return (
      <DepositProgress
        deposit={deposit}
        onReset={() => {
          updateState((current) => ({
            deposit: null,
            amount: "",
            showAmountError: false,
            recipient: "",
            error: null,
            refetchKey: current.refetchKey + 1,
          }));
        }}
      />
    );
  }

  if (wallets.length === 0) {
    return (
      <p className="text-secondary text-sm">
        {t("DashboardPrivateChannels.deposit.noWalletsBefore")}
        <Link
          className="text-primary underline underline-offset-2 hover:no-underline"
          href={PRIVATE_CHANNELS_OVERVIEW_PATH}
        >
          {t("DashboardPrivateChannels.deposit.noWalletsLink")}
        </Link>
        {t("DashboardPrivateChannels.deposit.noWalletsAfter")}
      </p>
    );
  }

  const amountErrorKey = showAmountError ? getAmountError(amount) : null;
  const amountError = amountErrorKey ? t(amountErrorKey) : null;
  // Falls back to the first token so a `mint` left over from a changed token list
  // cannot leave the label and the payload disagreeing.
  const selectedToken = tokens.find((token) => token.mint === mint) ?? tokens[0];

  const submit = () => {
    // An amount problem already renders under the field, so it is not repeated here.
    updateState({ showAmountError: true, error: null });
    if (getAmountError(amount)) {
      return;
    }
    startTransition(async () => {
      const result = await createDepositAction({
        walletId,
        amount: amount.trim(),
        mint: selectedToken?.mint,
        recipient: recipient.trim() || undefined,
      });
      if (result.ok) {
        updateState({ deposit: result.deposit });
        toast.success(t("DashboardPrivateChannels.deposit.submitToast"));
      } else if (result.kind === "server") {
        updateState({ error: result.message });
        toast.error(result.message);
      } else {
        updateState({ error: t(result.messageKey) });
      }
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="deposit-wallet">{t("DashboardPrivateChannels.deposit.fromWallet")}</Label>
        <Select onValueChange={(value) => updateState({ walletId: value ?? "" })} value={walletId}>
          {wallets.map((wallet) => (
            <SelectItem key={wallet.walletId} value={wallet.walletId}>
              {walletLabel(wallet)}
            </SelectItem>
          ))}
        </Select>
        <p className="text-secondary text-xs">
          {t("DashboardPrivateChannels.deposit.fromWalletHelp")}
        </p>
      </div>

      {tokens.length > 0 && (
        <div className="space-y-1.5">
          <Label>{t("DashboardPrivateChannels.common.tokenLabel")}</Label>
          <Select
            ariaLabel={t("DashboardPrivateChannels.common.tokenLabel")}
            onValueChange={(value) => updateState({ mint: value ?? "" })}
            value={mint}
          >
            {tokens.map((token) => (
              <SelectItem key={token.mint} value={token.mint}>
                {token.symbol}
              </SelectItem>
            ))}
          </Select>
        </div>
      )}

      <AmountField
        balances={balances}
        error={amountError}
        id="deposit-amount"
        spends="onChain"
        symbol={selectedToken?.symbol ?? ""}
        onBlur={() => updateState({ showAmountError: true })}
        onChange={(value) => updateState({ amount: value })}
        value={amount}
      />

      <div className="space-y-1.5">
        <Label htmlFor="deposit-recipient">{t("DashboardPrivateChannels.deposit.recipient")}</Label>
        <Input
          id="deposit-recipient"
          onChange={(event) => updateState({ recipient: event.target.value })}
          placeholder={t("DashboardPrivateChannels.deposit.recipientPlaceholder")}
          value={recipient}
        />
        <p className="text-secondary text-xs">
          {t("DashboardPrivateChannels.deposit.recipientHelp")}
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button
        disabled={isSubmitting || !walletId || !amount.trim()}
        iconLeft={isSubmitting ? <Loader2Icon className="size-4 animate-spin" /> : undefined}
        type="submit"
      >
        {t("DashboardPrivateChannels.deposit.submit")}
      </Button>
    </form>
  );
}
