import { type PaymentTransferSummary, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { cn } from "@/lib/utils";
import { formatDisplayAmount, shortenAddress } from "../payments-overview.utils";

type TransactionAmountFields = Pick<PaymentTransferSummary, "amount" | "token">;

export interface TransactionAmountPresentation {
  compacted: boolean;
  display: string;
  full: string;
}

export function getTransactionAmountPresentation(
  transfer: TransactionAmountFields,
  locale?: string
): TransactionAmountPresentation {
  const token = transfer.token?.trim() || undefined;
  const knownSymbol = token ? WELL_KNOWN_TOKEN_BY_MINT.get(token)?.symbol : undefined;
  const displayToken = knownSymbol ?? (token && token.length > 10 ? shortenAddress(token) : token);
  const display = formatDisplayAmount(transfer.amount, displayToken, locale);
  const full = formatDisplayAmount(transfer.amount, knownSymbol ?? token, locale);

  return { compacted: display !== full, display, full };
}

export function TransactionAmount({
  transfer,
  locale,
  className,
}: {
  transfer: PaymentTransferSummary;
  locale: string;
  className?: string;
}) {
  const amount = getTransactionAmountPresentation(transfer, locale);

  return (
    <span
      className={cn("block min-w-0 max-w-full truncate", className)}
      title={amount.compacted ? amount.full : undefined}
    >
      {amount.compacted ? (
        <>
          <span className="sr-only">{amount.full}</span>
          <span aria-hidden="true">{amount.display}</span>
        </>
      ) : (
        amount.display
      )}
    </span>
  );
}
