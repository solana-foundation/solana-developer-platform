/** A partner on the platform: its name (a proper noun, not copy) and its mark under /homepage/partners. */
export type StackPartner = {
  name: string;
  logo: string;
};

function partner(name: string, file: string): StackPartner {
  return { name, logo: `/homepage/partners/${file}.png` };
}

/** The partners passing under the stack, in order. */
export const STACK_PARTNERS: readonly StackPartner[] = [
  partner("Fireblocks", "fireblocks"),
  partner("Helius", "helius"),
  partner("Alchemy", "alchemy"),
  partner("Coinbase", "coinbase-cdp"),
  partner("BitGo", "bitgo"),
  partner("Anchorage", "anchorage"),
  partner("Turnkey", "turnkey"),
  partner("Privy", "privy"),
  partner("Para", "para"),
  partner("Dfns", "dfns"),
  partner("Utila", "utila"),
  partner("QuickNode", "quicknode"),
  partner("Triton", "triton"),
  partner("Nodit", "nodit"),
  partner("Validation Cloud", "validation-cloud"),
  partner("Chainalysis", "chainalysis"),
  partner("Elliptic", "elliptic"),
  partner("TRM Labs", "trm-labs"),
  partner("Range", "range"),
  partner("MoonPay", "moonpay"),
  partner("Stripe", "stripe"),
  partner("BVNK", "bvnk"),
  partner("MoneyGram", "moneygram"),
  partner("Lightspark", "lightspark"),
  partner("Mural", "mural"),
  partner("Kamino", "kamino"),
  partner("IBM", "ibm-digital-asset-haven"),
];
