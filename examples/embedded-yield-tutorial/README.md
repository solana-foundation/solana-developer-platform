# Embedded Yield, illustrated

A standalone, interactive guide page for [`examples/embedded-yield-bank`](../embedded-yield-bank). It walks through the Embedded Yield story in three scrolling screens, each pairing explanatory text with a visual crafted in CSS and React:

1. **Wallet** — a faux mobile phone running the "Northstar Wallet" app, where a fintech's customers hold dollars, euros, and the USDC stablecoin. Anyone holding stablecoins is a candidate for yield, and SDP's on-ramps can convert fiat into stablecoins.
2. **Configure** — a faux SDP Embedded Yield dashboard showing the repository's pinned mainnet Earn strategies (the curated Kamino shelf: Steakhouse High Yield USDG, Kamino Institutional Commodity Yield, Steakhouse USDC, and Steakhouse High Yield USDC). The strategies are backed by real-world assets (RWAs) like tokenized treasuries and private credit, and the customer's stablecoins move with one API request.
3. **Earn** — the same faux phone with an "Earn 8.43%" button on the USDC balance. The button presses itself, a confirmation shows the stablecoins are now earning, and a fast-forwarded 30-day simulation accrues yield with a balance chart rising up and to the right.

It is a pure front-end [Next.js](https://nextjs.org) app — no environment configuration, API keys, or chain access involved — so it deploys to Vercel as-is.

## Run it locally

From the repository root:

```bash
pnpm dev:example:embedded-yield-tutorial
```

or directly:

```bash
pnpm -C examples/embedded-yield-tutorial install
pnpm -C examples/embedded-yield-tutorial dev
```

Then open `http://127.0.0.1:4175`.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Set the project root directory to `examples/embedded-yield-tutorial`. Vercel detects Next.js automatically.
3. No environment variables are required.
4. Deploy.

## Checks

```bash
pnpm -C examples/embedded-yield-tutorial lint
pnpm -C examples/embedded-yield-tutorial typecheck
pnpm -C examples/embedded-yield-tutorial test
pnpm -C examples/embedded-yield-tutorial build
```

The yield math behind the animation is unit-tested in [`src/lib/yield.unit.test.ts`](src/lib/yield.unit.test.ts). For the real devnet integration — live balances, strategies, deposits, and movements — see the reference implementation in [`examples/embedded-yield-bank`](../embedded-yield-bank).
