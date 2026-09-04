"use client";

import type {
  CustodyWalletSummary,
  PrivateChannelTokenEligibility,
  PrivateChannelWithdrawal,
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
import { AmountField } from "../amount-field";
import { getAmountError } from "../amount-validation";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "../private-channels-routes";
import { fetchWalletBalancesAction, type WalletBalanceView } from "../wallet-balances";
import { createWithdrawalAction } from "./actions";
import { WithdrawProgress } from "./withdraw-progress";

function walletLabel(wallet: CustodyWalletSummary): string {
  const short = `${wallet.publicKey.slice(0, 4)}…${wallet.publicKey.slice(-4)}`;
  return wallet.label ? `${wallet.label} (${short})` : short;
}

interface WithdrawFormState {
  walletId: string;
  mint: string;
  amount: string;
  showAmountError: boolean;
  destination: string;
  error: string | null;
  withdrawal: PrivateChannelWithdrawal | null;
  balances: WalletBalanceView;
  refetchKey: number;
}

type WithdrawFormUpdate =
  | Partial<WithdrawFormState>
  | ((state: WithdrawFormState) => Partial<WithdrawFormState>);

function withdrawFormReducer(
  state: WithdrawFormState,
  update: WithdrawFormUpdate
): WithdrawFormState {
  const patch = typeof update === "function" ? update(state) : update;
  return { ...state, ...patch };
}

export function WithdrawForm({
  wallets,
  tokens,
}: {
  wallets: CustodyWalletSummary[];
  tokens: PrivateChannelTokenEligibility[];
}) {
  const [state, updateState] = useReducer(withdrawFormReducer, {
    walletId: wallets[0]?.walletId ?? "",
    mint: tokens[0]?.mint ?? "",
    amount: "",
    showAmountError: false,
    destination: "",
    error: null,
    withdrawal: null,
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
    destination,
    error,
    withdrawal,
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

  if (withdrawal) {
    return (
      <WithdrawProgress
        withdrawal={withdrawal}
        onReset={() => {
          updateState((current) => ({
            withdrawal: null,
            amount: "",
            showAmountError: false,
            destination: "",
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
        {t("DashboardPrivateChannels.withdraw.noWalletsBefore")}
        <Link
          className="text-primary underline underline-offset-2 hover:no-underline"
          href={PRIVATE_CHANNELS_OVERVIEW_PATH}
        >
          {t("DashboardPrivateChannels.withdraw.noWalletsLink")}
        </Link>
        {t("DashboardPrivateChannels.withdraw.noWalletsAfter")}
      </p>
    );
  }

  if (tokens.length === 0) {
    return (
      <p className="text-secondary text-sm">
        {t("DashboardPrivateChannels.common.noEnabledTokens")}
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
      const result = await createWithdrawalAction({
        walletId,
        amount: amount.trim(),
        mint: selectedToken?.mint,
        destination: destination.trim() || undefined,
      });
      if (result.ok) {
        updateState({ withdrawal: result.withdrawal });
        toast.success(t("DashboardPrivateChannels.withdraw.submitToast"));
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
        <Label htmlFor="withdraw-wallet">{t("DashboardPrivateChannels.withdraw.fromWallet")}</Label>
        <Select onValueChange={(value) => updateState({ walletId: value ?? "" })} value={walletId}>
          {wallets.map((wallet) => (
            <SelectItem key={wallet.walletId} value={wallet.walletId}>
              {walletLabel(wallet)}
            </SelectItem>
          ))}
        </Select>
        <p className="text-secondary text-xs">
          {t("DashboardPrivateChannels.withdraw.fromWalletHelp")}
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
        id="withdraw-amount"
        spends="channel"
        symbol={selectedToken?.symbol ?? ""}
        onBlur={() => updateState({ showAmountError: true })}
        onChange={(value) => updateState({ amount: value })}
        value={amount}
      />

      <div className="space-y-1.5">
        <Label htmlFor="withdraw-destination">
          {t("DashboardPrivateChannels.withdraw.destination")}
        </Label>
        <Input
          id="withdraw-destination"
          onChange={(event) => updateState({ destination: event.target.value })}
          placeholder={t("DashboardPrivateChannels.withdraw.destinationPlaceholder")}
          value={destination}
        />
        <p className="text-secondary text-xs">
          {t("DashboardPrivateChannels.withdraw.destinationHelp")}
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button
        disabled={isSubmitting || !walletId || !amount.trim()}
        iconLeft={isSubmitting ? <Loader2Icon className="size-4 animate-spin" /> : undefined}
        type="submit"
      >
        {t("DashboardPrivateChannels.withdraw.submit")}
      </Button>
    </form>
  );
}
