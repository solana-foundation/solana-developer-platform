import type { EarnTableColumns } from "@/app/dashboard/[projectId]/markets/earn/earn-table-layout";

function percent(token: string | undefined): number | undefined {
  const match = token?.match(/w-\[(\d+)%\]$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * A fixed-layout column's share of its table on a phone and from `@2xl`, read off its width
 * classes; 0 where the column is hidden.
 */
export function tableColumnShares(className: string): { phone: number; wide: number } {
  const tokens = className.split(/\s+/);
  const phoneWidth = percent(tokens.find((token) => token.startsWith("w-[")));
  const wideWidth = percent(tokens.find((token) => token.startsWith("@2xl:w-["))) ?? phoneWidth;
  const hiddenOnPhone = tokens.includes("hidden");
  const shownWide = !hiddenOnPhone || tokens.includes("@2xl:table-cell");
  return {
    phone: hiddenOnPhone ? 0 : (phoneWidth ?? Number.NaN),
    wide: shownWide ? (wideWidth ?? Number.NaN) : 0,
  };
}

/** How much of the table its columns fill on a phone and from `@2xl`, in percent. */
export function tableColumnTotals(columns: EarnTableColumns): {
  phone: number;
  wide: number;
} {
  const shares = Object.values(columns).map(tableColumnShares);
  return {
    phone: shares.reduce((sum, share) => sum + share.phone, 0),
    wide: shares.reduce((sum, share) => sum + share.wide, 0),
  };
}
