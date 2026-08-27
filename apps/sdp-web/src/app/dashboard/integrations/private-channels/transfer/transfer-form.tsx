"use client";

import type {
  CustodyWalletSummary,
  PrivateChannelMembershipChannelDto,
  PrivateChannelTransfer,
  PrivateChannelTransferRecipientDto,
} from "@sdp/types";
import { privateChannelTokens } from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
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
}

interface TransferFormState {
  channelId: string;
  walletId: string;
  mint: string;
  recipientVerifiedWalletId: string;
  amount: string;
  showAmountError: boolean;
  recipientLoad: RecipientLoadState;
  recipientReload: number;
  balances: WalletBalanceView;
  balanceRefetchKey: number;
  error: string | null;
  submittedTransfer: SubmittedTransfer | null;
}

type TransferFormUpdate =
  | Partial<TransferFormState>
  | ((state: TransferFormState) => Partial<TransferFormState>);

function transferFormReducer(
  state: TransferFormState,
  update: TransferFormUpdate
): TransferFormState {
  const patch = typeof update === "function" ? update(state) : update;
  return { ...state, ...patch };
}

function shortenPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

function walletLabel(wallet: CustodyWalletSummary): string {
  const short = shortenPubkey(wallet.publicKey);
  return wallet.label ? `${wallet.label} (${short})` : short;
}

/**
 * Recipients are wallets, not people, so a member holding several verified
 * wallets yields several options. The source wallet is dropped because a
 * transfer to itself is rejected by the API.
 */
function toRecipientOptions(
  recipients: PrivateChannelTransferRecipientDto[],
  sourcePubkey: string | undefined
): RecipientOption[] {
  return recipients
    .filter((recipient) => recipient.pubkey !== sourcePubkey)
    .map((recipient) => {
      const short = shortenPubkey(recipient.pubkey);
      const walletName = recipient.walletName?.trim();
      return { id: recipient.id, label: walletName ? `${walletName} (${short})` : short };
    });
}

export function TransferForm({ scopeKey, ...props }: TransferFormProps) {
  return <TransferFormState key={scopeKey} {...props} />;
}

function TransferFormState({ channels, sourceWallets }: Omit<TransferFormProps, "scopeKey">) {
  const tokens = privateChannelTokens(useSolanaCluster());
  const t = useTranslations();
  const [state, updateState] = useReducer(transferFormReducer, {
    channelId: channels[0]?.id ?? "",
    walletId: sourceWallets[0]?.walletId ?? "",
    mint: tokens[0]?.mint ?? "",
    recipientVerifiedWalletId: "",
    amount: "",
    showAmountError: false,
    recipientLoad: { status: "idle" },
    recipientReload: 0,
    balances: { channel: null, onChain: null },
    balanceRefetchKey: 0,
    error: null,
    submittedTransfer: null,
  });
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
  const {
    channelId,
    walletId,
    mint,
    recipientVerifiedWalletId,
    amount,
    showAmountError,
    recipientLoad,
    recipientReload,
    balanceRefetchKey,
    submittedTransfer,
  } = state;

  const selectedSource = sourceWallets.find((wallet) => wallet.walletId === walletId);
  const sourcePubkey = selectedSource?.publicKey;
  const recipientOptions = useMemo(
    () =>
      recipientLoad.status === "ready"
        ? toRecipientOptions(recipientLoad.recipients, sourcePubkey)
        : [],
    [recipientLoad, sourcePubkey]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: recipientReload intentionally triggers a fresh server-action request.
  useEffect(() => {
    const request = ++recipientRequest.current;
    let active = true;
    updateState({ recipientVerifiedWalletId: "" });

    if (!channelId || channels.length === 0 || sourceWallets.length === 0) {
      updateState({ recipientLoad: { status: "idle" } });
      return;
    }

    updateState({ recipientLoad: { status: "loading" } });
    void (async () => {
      try {
        const result = await fetchTransferRecipientsAction(channelId);
        if (!active || request !== recipientRequest.current) {
          return;
        }
        if (result.ok) {
          updateState({ recipientLoad: { status: "ready", recipients: result.recipients } });
        } else {
          updateState({
            recipientLoad: {
              status: "error",
              message: "messageKey" in result ? t(result.messageKey) : result.message,
            },
          });
        }
      } catch (loadError) {
        if (!active || request !== recipientRequest.current) {
          return;
        }
        updateState({
          recipientLoad: {
            status: "error",
            message:
              loadError instanceof Error
                ? loadError.message
                : t("DashboardPrivateChannels.transfer.recipientsLoadFailed"),
          },
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [channelId, channels.length, recipientReload, sourceWallets.length, t]);

  /**
   * Switching the source wallet to the one already chosen as recipient drops that
   * option, so a selection that is no longer offered must not survive as state.
   */
  useEffect(() => {
    if (
      recipientVerifiedWalletId &&
      !recipientOptions.some((option) => option.id === recipientVerifiedWalletId)
    ) {
      updateState({ recipientVerifiedWalletId: "" });
    }
  }, [recipientOptions, recipientVerifiedWalletId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: balanceRefetchKey intentionally triggers a fresh balance read.
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
  }, [walletId, mint, balanceRefetchKey]);

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

  const selectedRecipient = recipientOptions.find(
    (recipient) => recipient.id === recipientVerifiedWalletId
  );

  const reset = () => {
    submitting.current = false;
    updateState((current) => ({
      submittedTransfer: null,
      channelId: channels[0]?.id ?? "",
      walletId: sourceWallets[0]?.walletId ?? "",
      mint: tokens[0]?.mint ?? "",
      recipientVerifiedWalletId: "",
      amount: "",
      showAmountError: false,
      error: null,
      balanceRefetchKey: current.balanceRefetchKey + 1,
      recipientReload: current.recipientReload + 1,
    }));
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

    updateState({ showAmountError: true });
    let selectionKey: MessageKey | null = null;
    if (!recipientVerifiedWalletId) {
      selectionKey = "DashboardPrivateChannels.transfer.selectRecipient";
    } else if (!channelId || !walletId) {
      selectionKey = "DashboardPrivateChannels.transfer.incomplete";
    }
    if (selectionKey || getAmountError(amount)) {
      // An amount problem already renders under the field, so it is not repeated here.
      updateState({ error: selectionKey ? t(selectionKey) : null });
      return;
    }

    const submittedLabels = {
      recipientLabel: selectedRecipient?.label,
      senderLabel: selectedSource ? walletLabel(selectedSource) : undefined,
    };
    submitting.current = true;
    updateState({ error: null });

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
          updateState({ submittedTransfer: { transfer: result.transfer, ...submittedLabels } });
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
          updateState({ error: result.message });
          toast.error(result.message);
        } else {
          updateState({ error: t(result.messageKey) });
        }
      } catch (submitError) {
        const message =
          submitError instanceof Error
            ? submitError.message
            : t("DashboardPrivateChannels.transfer.submitFailed");
        updateState({ error: message });
        toast.error(message);
      } finally {
        submitting.current = false;
      }
    });
  };

  return (
    <TransferFields
      amountError={amountError}
      channels={channels}
      isSubmitting={isSubmitting}
      recipientOptions={recipientOptions}
      recipientRequest={recipientRequest}
      selectedTokenSymbol={selectedToken?.symbol ?? ""}
      sourceWallets={sourceWallets}
      state={state}
      submitting={submitting}
      t={t}
      tokens={tokens}
      updateState={updateState}
      onSubmit={submit}
    />
  );
}

type Translate = ReturnType<typeof useTranslations>;

function TransferFields(props: {
  amountError: string | null;
  channels: PrivateChannelMembershipChannelDto[];
  isSubmitting: boolean;
  recipientOptions: RecipientOption[];
  recipientRequest: { current: number };
  selectedTokenSymbol: string;
  sourceWallets: CustodyWalletSummary[];
  state: TransferFormState;
  submitting: { current: boolean };
  t: Translate;
  tokens: ReturnType<typeof privateChannelTokens>;
  updateState: (update: TransferFormUpdate) => void;
  onSubmit: () => void;
}) {
  const {
    amount,
    balances,
    channelId,
    error,
    mint,
    recipientLoad,
    recipientVerifiedWalletId,
    walletId,
  } = props.state;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="space-y-1.5">
        <Label>{props.t("DashboardPrivateChannels.transfer.channel")}</Label>
        <Select
          ariaLabel={props.t("DashboardPrivateChannels.transfer.channel")}
          disabled={props.isSubmitting}
          value={channelId}
          onValueChange={(value) => {
            if (props.submitting.current) return;
            const next = value ?? "";
            if (next !== channelId) {
              props.recipientRequest.current += 1;
              props.updateState({
                error: null,
                channelId: next,
                recipientVerifiedWalletId: "",
              });
            }
          }}
        >
          {props.channels.map((channel) => (
            <SelectItem key={channel.id} value={channel.id}>
              {channel.name}
              {channel.isDefault
                ? props.t("DashboardPrivateChannels.transfer.channelDefaultSuffix")
                : ""}
            </SelectItem>
          ))}
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>{props.t("DashboardPrivateChannels.transfer.fromWallet")}</Label>
        <Select
          ariaLabel={props.t("DashboardPrivateChannels.transfer.fromWallet")}
          disabled={props.isSubmitting}
          value={walletId}
          onValueChange={(value) => {
            if (props.submitting.current) return;
            const next = value ?? "";
            if (next !== walletId) {
              props.updateState({ error: null, walletId: next });
            }
          }}
        >
          {props.sourceWallets.map((wallet) => (
            <SelectItem key={wallet.walletId} value={wallet.walletId}>
              {walletLabel(wallet)}
            </SelectItem>
          ))}
        </Select>
        <p className="text-secondary text-xs">
          {props.t("DashboardPrivateChannels.transfer.fromWalletHelp")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{props.t("DashboardPrivateChannels.transfer.recipientWallet")}</Label>
        {recipientLoad.status === "loading" && (
          <p aria-live="polite" className="text-sm text-secondary" role="status">
            {props.t("DashboardPrivateChannels.transfer.recipientsLoading")}
          </p>
        )}
        {recipientLoad.status === "error" && (
          <div className="space-y-2" role="alert">
            <p className="text-destructive text-sm">{recipientLoad.message}</p>
            <Button
              disabled={props.isSubmitting}
              onClick={() => {
                if (!props.submitting.current) {
                  props.updateState((current) => ({
                    recipientReload: current.recipientReload + 1,
                  }));
                }
              }}
              type="button"
              variant="secondary"
            >
              {props.t("DashboardPrivateChannels.transfer.recipientsRetry")}
            </Button>
          </div>
        )}
        {recipientLoad.status === "ready" && props.recipientOptions.length === 0 && (
          <p className="text-sm text-secondary">
            {props.t("DashboardPrivateChannels.transfer.recipientsEmpty")}
          </p>
        )}
        {recipientLoad.status === "ready" && props.recipientOptions.length > 0 && (
          <Select
            ariaLabel={props.t("DashboardPrivateChannels.transfer.recipientWallet")}
            disabled={props.isSubmitting}
            value={recipientVerifiedWalletId}
            onValueChange={(value) => {
              if (props.submitting.current) return;
              const next = value ?? "";
              if (next !== recipientVerifiedWalletId) {
                props.updateState({ error: null, recipientVerifiedWalletId: next });
              }
            }}
          >
            {props.recipientOptions.map((recipient) => (
              <SelectItem key={recipient.id} value={recipient.id}>
                {recipient.label}
              </SelectItem>
            ))}
          </Select>
        )}
      </div>

      {props.tokens.length > 0 && (
        <div className="space-y-1.5">
          <Label>{props.t("DashboardPrivateChannels.common.tokenLabel")}</Label>
          <Select
            ariaLabel={props.t("DashboardPrivateChannels.common.tokenLabel")}
            disabled={props.isSubmitting}
            value={mint}
            onValueChange={(value) => {
              // Same freeze as the other financial fields — see the `submitting` note.
              if (props.submitting.current) return;
              const next = value ?? "";
              if (next !== mint) {
                props.updateState({ error: null, mint: next });
              }
            }}
          >
            {props.tokens.map((token) => (
              <SelectItem key={token.mint} value={token.mint}>
                {token.symbol}
              </SelectItem>
            ))}
          </Select>
        </div>
      )}

      <AmountField
        balances={balances}
        disabled={props.isSubmitting}
        error={props.amountError}
        id="transfer-amount"
        spends="channel"
        symbol={props.selectedTokenSymbol}
        onBlur={() => {
          if (!props.submitting.current) props.updateState({ showAmountError: true });
        }}
        onChange={(next) => {
          if (props.submitting.current || next === amount) return;
          props.updateState({ error: null, amount: next });
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
          props.isSubmitting ||
          !channelId ||
          !walletId ||
          !recipientVerifiedWalletId ||
          !amount.trim()
        }
        iconLeft={props.isSubmitting ? <Loader2Icon className="size-4 animate-spin" /> : undefined}
        type="submit"
      >
        {props.t("DashboardPrivateChannels.transfer.submit")}
      </Button>
    </form>
  );
}
