export function truncateMiddle(value: string, start = 6, end = 4): string {
  if (value.length <= start + end + 3) {
    return value;
  }

  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function formatWalletMeta(value: string, start = 8, end = 6): string {
  return truncateMiddle(value, start, end);
}

export function formatPurpose(value: string | null): string | null {
  if (!value) {
    return null;
  }

  switch (value) {
    case "root":
      return null;
    case "mint_authority":
      return "Mint authority";
    case "freeze_authority":
      return "Freeze authority";
    case "fee_payer":
      return "Fee payer";
    case "transfer":
      return "Transfers";
    default:
      return value.replaceAll("_", " ");
  }
}
