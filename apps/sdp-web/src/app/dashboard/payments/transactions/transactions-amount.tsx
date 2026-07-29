import { type PaymentTransferSummary, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { cn } from "@/lib/utils";
import { formatDisplayAmount, resolveTransferTokenLabel } from "../payments-overview.utils";

type TransactionAmountFields = Pick<PaymentTransferSummary, "amount" | "token">;

export interface TransactionAmountPresentation {
  compacted: boolean;
  display: string;
  full: string;
}

export function getTransactionAmountPresentation(
  transfer: TransactionAmountFields,
  locale?: string,
  /** Symbols for tokens this org issued, keyed by mint. The catalogue never knows them. */
  issuedTokenSymbolsByMint?: Readonly<Record<string, string>>
): TransactionAmountPresentation {
  const token = transfer.token?.trim() || undefined;
  const knownSymbol = token ? WELL_KNOWN_TOKEN_BY_MINT.get(token)?.symbol : undefined;
  const issuedSymbol = token ? issuedTokenSymbolsByMint?.[token] : undefined;
  const displayToken = resolveTransferTokenLabel(token, issuedTokenSymbolsByMint);
  const display = formatDisplayAmount(transfer.amount, displayToken, locale);
  const full = formatDisplayAmount(transfer.amount, knownSymbol ?? issuedSymbol ?? token, locale);

  return { compacted: display !== full, display, full };
}

export function TransactionAmount({
  transfer,
  locale,
  issuedTokenSymbolsByMint,
  className,
}: {
  transfer: PaymentTransferSummary;
  locale: string;
  issuedTokenSymbolsByMint?: Readonly<Record<string, string>>;
  className?: string;
}) {
  const amount = getTransactionAmountPresentation(transfer, locale, issuedTokenSymbolsByMint);

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
