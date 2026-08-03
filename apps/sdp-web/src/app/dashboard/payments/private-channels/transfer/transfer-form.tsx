"use client";

import type {
  CustodyWalletSummary,
  PrivateChannelMembershipChannelDto,
  PrivateChannelToken,
  PrivateChannelTransfer,
  PrivateChannelTransferRecipientDto,
} from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { AmountField } from "../amount-field";
import { getAmountError } from "../amount-validation";
import { fetchWalletBalancesAction, type WalletBalanceView } from "../wallet-balances";
import { createTransferAction, fetchTransferRecipientsAction } from "./actions";
import { TransferProgress } from "./transfer-progress";

interface RecipientOption {
  id: string;
  label: string;
}

interface SubmittedTransfer {
  transfer: PrivateChannelTransfer;
  senderLabel?: string;
  recipientLabel?: string;
}

type RecipientLoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; recipients: PrivateChannelTransferRecipientDto[] }
  | { status: "error"; message: string };

interface TransferFormProps {
  channels: PrivateChannelMembershipChannelDto[];
  scopeKey: string;
  sourceWallets: CustodyWalletSummary[];
  tokens: PrivateChannelToken[];
}

function shortenPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

function walletLabel(wallet: CustodyWalletSummary): string {
  const short = shortenPubkey(wallet.publicKey);
  return wallet.label ? `${wallet.label} (${short})` : short;
}

function flattenRecipientOptions(
  recipients: PrivateChannelTransferRecipientDto[]
): RecipientOption[] {
  return recipients.flatMap((recipient) => {
    const member = recipient.name?.trim()
      ? `${recipient.name.trim()} (${recipient.email})`
      : recipient.email;
    return recipient.wallets.map((wallet) => ({
      id: wallet.id,
      label: `${member} · ${shortenPubkey(wallet.pubkey)}`,
    }));
  });
}

export function TransferForm({ scopeKey, ...props }: TransferFormProps) {
  return <TransferFormState key={scopeKey} {...props} />;
}

function TransferFormState({
  channels,
  sourceWallets,
  tokens,
}: Omit<TransferFormProps, "scopeKey">) {
  const t = useTranslations();
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [walletId, setWalletId] = useState(sourceWallets[0]?.walletId ?? "");
  const [mint, setMint] = useState(tokens[0]?.mint ?? "");
  const [recipientVerifiedWalletId, setRecipientVerifiedWalletId] = useState("");
  const [amount, setAmount] = useState("");
  const [showAmountError, setShowAmountError] = useState(false);
  const [recipientLoad, setRecipientLoad] = useState<RecipientLoadState>({ status: "idle" });
  const [recipientReload, setRecipientReload] = useState(0);
  const [balances, setBalances] = useState<WalletBalanceView>({ channel: null, onChain: null });
  const [error, setError] = useState<string | null>(null);
  const [submittedTransfer, setSubmittedTransfer] = useState<SubmittedTransfer | null>(null);
  const [isSubmitting, startTransition] = useTransition();
  const recipientRequest = useRef(0);
  /**
   * Freezes every financial field for the duration of a submit. Deliberately NOT
   * redundant with `disabled={isSubmitting}`: the transition state lags a tick
   * behind the submit, and `disabled` on a `Select` only reaches a third-party
   * component's internals. On a money path the guard is explicit here so the
   * freeze holds regardless of either.
   */
  const submitting = useRef(false);

  const recipientOptions = useMemo(
    () =>
      recipientLoad.status === "ready" ? flattenRecipientOptions(recipientLoad.recipients) : [],
    [recipientLoad]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: recipientReload intentionally triggers a fresh server-action request.
  useEffect(() => {
    const request = ++recipientRequest.current;
    let active = true;
    setRecipientVerifiedWalletId("");

    if (!channelId || channels.length === 0 || sourceWallets.length === 0) {
      setRecipientLoad({ status: "idle" });
      return;
    }

    setRecipientLoad({ status: "loading" });
    void (async () => {
      try {
        const result = await fetchTransferRecipientsAction(channelId);
        if (!active || request !== recipientRequest.current) {
          return;
        }
        if (result.ok) {
          setRecipientLoad({ status: "ready", recipients: result.recipients });
        } else {
          setRecipientLoad({
            status: "error",
            message: "messageKey" in result ? t(result.messageKey) : result.message,
          });
        }
      } catch (loadError) {
        if (!active || request !== recipientRequest.current) {
          return;
        }
        setRecipientLoad({
          status: "error",
          message:
            loadError instanceof Error
              ? loadError.message
              : t("DashboardPrivateChannels.transfer.recipientsLoadFailed"),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [channelId, channels.length, recipientReload, sourceWallets.length, t]);

  useEffect(() => {
    if (!walletId) {
      setBalances({ channel: null, onChain: null });
      return;
    }
    let active = true;
    setBalances({ channel: null, onChain: null });
    fetchWalletBalancesAction(walletId, mint || undefined).then((result) => {
      if (active) setBalances(result);
    });
    return () => {
      active = false;
    };
  }, [walletId, mint]);

  if (channels.length === 0) {
    return (
      <p className="text-sm text-secondary">{t("DashboardPrivateChannels.transfer.noChannels")}</p>
    );
  }

  if (sourceWallets.length === 0) {
    return (
      <p className="text-sm text-secondary">
        {t("DashboardPrivateChannels.transfer.noSourceWallets")}
      </p>
    );
  }

  const selectedSource = sourceWallets.find((wallet) => wallet.walletId === walletId);
  const selectedRecipient = recipientOptions.find(
    (recipient) => recipient.id === recipientVerifiedWalletId
  );

  const reset = () => {
    submitting.current = false;
    setSubmittedTransfer(null);
    setChannelId(channels[0]?.id ?? "");
    setWalletId(sourceWallets[0]?.walletId ?? "");
    setMint(tokens[0]?.mint ?? "");
    setRecipientVerifiedWalletId("");
    setAmount("");
    setShowAmountError(false);
    setError(null);
    setRecipientReload((value) => value + 1);
  };

  if (submittedTransfer) {
    return (
      <TransferProgress
        recipientLabel={submittedTransfer.recipientLabel}
        senderLabel={submittedTransfer.senderLabel}
        transfer={submittedTransfer.transfer}
        onReset={reset}
      />
    );
  }

  const amountErrorKey = showAmountError ? getAmountError(amount) : null;
  const amountError = amountErrorKey ? t(amountErrorKey) : null;
  // Falls back to the first token so a `mint` left over from a changed token list
  // cannot leave the label and the payload disagreeing. Relevant here because the
  // remount key excludes the instance's RPC URL, so `tokens` can change in place.
  const selectedToken = tokens.find((token) => token.mint === mint) ?? tokens[0];

  const submit = () => {
    if (submitting.current) {
      return;
    }

    setShowAmountError(true);
    let selectionKey: MessageKey | null = null;
    if (!recipientVerifiedWalletId) {
      selectionKey = "DashboardPrivateChannels.transfer.selectRecipient";
    } else if (!channelId || !walletId) {
      selectionKey = "DashboardPrivateChannels.transfer.incomplete";
    }
    if (selectionKey || getAmountError(amount)) {
      // An amount problem already renders under the field, so it is not repeated here.
      setError(selectionKey ? t(selectionKey) : null);
      return;
    }

    const submittedLabels = {
      recipientLabel: selectedRecipient?.label,
      senderLabel: selectedSource ? walletLabel(selectedSource) : undefined,
    };
    submitting.current = true;
    setError(null);

    startTransition(async () => {
      try {
        const result = await createTransferAction({
          channelId,
          walletId,
          recipientVerifiedWalletId,
          amount: amount.trim(),
          mint: selectedToken?.mint,
        });
        if (result.ok) {
          setSubmittedTransfer({ transfer: result.transfer, ...submittedLabels });
          if (result.transfer.status === "failed") {
            toast.error(
              result.transfer.failureReason ?? t("DashboardPrivateChannels.transfer.failedToast")
            );
          } else if (result.transfer.status === "confirmed") {
            toast.success(t("DashboardPrivateChannels.transfer.confirmedToast"));
          } else {
            // `submitted`/`pending`: accepted but no execution verdict, so this must
            // not be a success toast.
            toast.warning(t("DashboardPrivateChannels.transfer.submittedToast"));
          }
        } else if (result.kind === "server") {
          setError(result.message);
          toast.error(result.message);
        } else {
          setError(t(result.messageKey));
        }
      } catch (submitError) {
        const message =
          submitError instanceof Error
            ? submitError.message
            : t("DashboardPrivateChannels.transfer.submitFailed");
        setError(message);
        toast.error(message);
      } finally {
        submitting.current = false;
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
        <Label>{t("DashboardPrivateChannels.transfer.channel")}</Label>
        <Select
          ariaLabel={t("DashboardPrivateChannels.transfer.channel")}
          disabled={isSubmitting}
          value={channelId}
          onValueChange={(value) => {
            if (submitting.current) return;
            const next = value ?? "";
            if (next !== channelId) {
              setError(null);
              recipientRequest.current += 1;
              setChannelId(next);
              setRecipientVerifiedWalletId("");
            }
          }}
        >
          {channels.map((channel) => (
            <SelectItem key={channel.id} value={channel.id}>
              {channel.name}
              {channel.isDefault ? t("DashboardPrivateChannels.transfer.channelDefaultSuffix") : ""}
            </SelectItem>
          ))}
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>{t("DashboardPrivateChannels.transfer.fromWallet")}</Label>
        <Select
          ariaLabel={t("DashboardPrivateChannels.transfer.fromWallet")}
          disabled={isSubmitting}
          value={walletId}
          onValueChange={(value) => {
            if (submitting.current) return;
            const next = value ?? "";
            if (next !== walletId) {
              setError(null);
              setWalletId(next);
            }
          }}
        >
          {sourceWallets.map((wallet) => (
            <SelectItem key={wallet.walletId} value={wallet.walletId}>
              {walletLabel(wallet)}
            </SelectItem>
          ))}
        </Select>
        <p className="text-secondary text-xs">
          {t("DashboardPrivateChannels.transfer.fromWalletHelp")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t("DashboardPrivateChannels.transfer.recipientWallet")}</Label>
        {recipientLoad.status === "loading" && (
          <p aria-live="polite" className="text-sm text-secondary" role="status">
            {t("DashboardPrivateChannels.transfer.recipientsLoading")}
          </p>
        )}
        {recipientLoad.status === "error" && (
          <div className="space-y-2" role="alert">
            <p className="text-destructive text-sm">{recipientLoad.message}</p>
            <Button
              disabled={isSubmitting}
              onClick={() => {
                if (!submitting.current) setRecipientReload((value) => value + 1);
              }}
              type="button"
              variant="secondary"
            >
              {t("DashboardPrivateChannels.transfer.recipientsRetry")}
            </Button>
          </div>
        )}
        {recipientLoad.status === "ready" && recipientOptions.length === 0 && (
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.transfer.recipientsEmpty")}
          </p>
        )}
        {recipientLoad.status === "ready" && recipientOptions.length > 0 && (
          <Select
            ariaLabel={t("DashboardPrivateChannels.transfer.recipientWallet")}
            disabled={isSubmitting}
            value={recipientVerifiedWalletId}
            onValueChange={(value) => {
              if (submitting.current) return;
              const next = value ?? "";
              if (next !== recipientVerifiedWalletId) {
                setError(null);
                setRecipientVerifiedWalletId(next);
              }
            }}
          >
            {recipientOptions.map((recipient) => (
              <SelectItem key={recipient.id} value={recipient.id}>
                {recipient.label}
              </SelectItem>
            ))}
          </Select>
        )}
      </div>

      {tokens.length > 0 && (
        <div className="space-y-1.5">
          <Label>{t("DashboardPrivateChannels.common.tokenLabel")}</Label>
          <Select
            ariaLabel={t("DashboardPrivateChannels.common.tokenLabel")}
            disabled={isSubmitting}
            value={mint}
            onValueChange={(value) => {
              // Same freeze as the other financial fields — see the `submitting` note.
              if (submitting.current) return;
              const next = value ?? "";
              if (next !== mint) {
                setError(null);
                setMint(next);
              }
            }}
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
        disabled={isSubmitting}
        error={amountError}
        id="transfer-amount"
        spends="channel"
        symbol={selectedToken?.symbol ?? ""}
        onBlur={() => {
          if (!submitting.current) setShowAmountError(true);
        }}
        onChange={(next) => {
          if (submitting.current || next === amount) return;
          setError(null);
          setAmount(next);
        }}
        value={amount}
      />

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      <Button
        disabled={
          isSubmitting || !channelId || !walletId || !recipientVerifiedWalletId || !amount.trim()
        }
        iconLeft={isSubmitting ? <Loader2Icon className="size-4 animate-spin" /> : undefined}
        type="submit"
      >
        {t("DashboardPrivateChannels.transfer.submit")}
      </Button>
    </form>
  );
}
