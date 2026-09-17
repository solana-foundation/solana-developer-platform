/**
 * The repository's pinned mainnet Earn shelf — the four curated Kamino vaults
 * from `CURATED_VAULTS["mainnet-beta"]` in the API's earn curation config
 * (`apps/sdp-api/src/routes/earn/handlers/curation.ts`). TVL and APY figures
 * come from the repo's catalogue inventory snapshot (2026-09-01,
 * `docs/earn/kamino-catalogue-inventory.md`); treat them as illustrative.
 */
const MAINNET_STRATEGIES = [
  {
    name: "Kamino Institutional Commodity Yield",
    provider: "kamino",
    asset: "USDC",
    tvl: "$32.0M",
    apy: "8.43%",
    surfaced: true,
  },
  {
    name: "Steakhouse High Yield USDG",
    provider: "kamino",
    asset: "USDG",
    tvl: "$43.3M",
    apy: "4.34%",
    surfaced: true,
  },
  {
    name: "Steakhouse USDC",
    provider: "kamino",
    asset: "USDC",
    tvl: "$18.6M",
    apy: "3.41%",
    surfaced: false,
  },
  {
    name: "Steakhouse High Yield USDC",
    provider: "kamino",
    asset: "USDC",
    tvl: "$3.6M",
    apy: "4.84%",
    surfaced: false,
  },
];

const assetMarkClass: Record<string, string> = {
  USDC: "bg-[#2775CA]/10 text-[#2775CA]",
  USDG: "bg-[#2F7A68]/10 text-[#2F7A68]",
};

/**
 * Step 2 visual: the SDP Embedded Yield strategy picker, replicated with plain
 * CSS and showing what mainnet looks like — the pinned mainnet strategies a
 * wallet team would surface to its customers.
 */
export function DashboardPreview() {
  return (
    <figure className="w-full max-w-xl">
      <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-background shadow-xl shadow-foreground/10">
        <div className="flex items-center gap-2 border-b border-foreground/10 bg-app px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </span>
          <span className="flex-1 truncate rounded-md bg-foreground/5 px-3 py-1 text-xs text-muted-foreground">
            localhost:3000/dashboard/markets/embedded-yield
          </span>
        </div>
        <div className="bg-background p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                Earn strategies
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Choose which strategies your customers can enter.
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
              mainnet-beta
            </span>
          </div>
          <table className="mt-4 w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr className="text-[10px] tracking-wider text-muted-foreground uppercase">
                <th scope="col" className="w-8 py-1.5 pr-2 font-semibold">
                  <span className="sr-only">Select</span>
                </th>
                <th scope="col" className="py-1.5 font-semibold">
                  Strategy
                </th>
                <th scope="col" className="py-1.5 font-semibold">
                  Asset
                </th>
                <th scope="col" className="py-1.5 text-right font-semibold">
                  TVL
                </th>
                <th scope="col" className="py-1.5 text-right font-semibold">
                  APY
                </th>
              </tr>
            </thead>
            <tbody>
              {MAINNET_STRATEGIES.map((strategy) => (
                <tr
                  key={strategy.name}
                  className="border-t border-foreground/5"
                >
                  <td className="py-2 pr-2 align-middle">
                    <span
                      aria-hidden="true"
                      className={`flex size-4 items-center justify-center rounded-full border ${
                        strategy.surfaced
                          ? "border-success"
                          : "border-foreground/25 bg-background"
                      }`}
                    >
                      {strategy.surfaced ? (
                        <span className="size-2 rounded-full bg-success" />
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2 align-middle">
                    <p className="text-[13px] font-medium text-foreground">
                      {strategy.name}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {strategy.provider}
                    </p>
                  </td>
                  <td className="py-2 align-middle">
                    <span
                      className={`flex items-center gap-1.5 text-xs font-medium ${
                        assetMarkClass[strategy.asset] ?? ""
                      } rounded-full px-2 py-0.5`}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                      {strategy.asset}
                    </span>
                  </td>
                  <td className="py-2 text-right align-middle text-xs text-foreground tabular-nums">
                    {strategy.tvl}
                  </td>
                  <td className="py-2 text-right align-middle text-xs font-semibold text-success tabular-nums">
                    {strategy.apy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Curated shelf · catalogue snapshot, September 2026
          </p>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">
        The SDP Embedded Yield page where the wallet team chooses the one Earn
        strategy its customers can enter — here, the pinned mainnet shelf.
      </figcaption>
    </figure>
  );
}
