import { cn } from "@/lib/utils";

export function AmountBalanceReadout({
  available,
  assetLabel,
  exceeds,
  onMax,
}: {
  available: string;
  assetLabel: string;
  exceeds: boolean;
  onMax?: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <span
        className={cn("whitespace-nowrap", exceeds ? "text-status-error-text" : "text-text-low")}
      >
        {available} {assetLabel}
      </span>
      {onMax ? (
        <>
          <span className="h-3.5 w-px shrink-0 bg-border-medium" aria-hidden="true" />
          <button
            type="button"
            className="shrink-0 rounded-md bg-border-light px-2 py-0.5 text-xs font-semibold text-text-medium transition-colors hover:bg-border-medium"
            onClick={onMax}
          >
            MAX
          </button>
        </>
      ) : null}
    </div>
  );
}
