"use client";

import {
  ArrowDownIcon,
  CircleArrowDownIcon,
  KeyRoundIcon,
  LandmarkIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { DashboardPreview } from "@/components/dashboard-preview";
import { EarnDemo } from "@/components/earn-demo";
import { PhoneFrame } from "@/components/phone-frame";
import { Reveal } from "@/components/reveal";
import { CustodyScreen } from "@/components/wallet-app";

const STEPS = [
  { id: "custody", label: "Wallet" },
  { id: "configure", label: "Configure" },
  { id: "earn", label: "Earn" },
];

function StepNav({ activeId }: { activeId: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-foreground/10 bg-app/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <p className="text-sm font-bold tracking-tight text-foreground">
          Stablecoin Savings Account
          <span className="text-muted-foreground"> for your users</span>
        </p>
        <nav className="flex items-center gap-1 text-xs font-semibold">
          {STEPS.map((step, index) => (
            <a
              key={step.id}
              href={`#${step.id}`}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                activeId === step.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              <span className="tabular-nums opacity-60">0{index + 1}</span>{" "}
              {step.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-16 pb-10 lg:pt-24 lg:pb-16">
      <Reveal>
        <p className="inline-flex items-center gap-1.5 rounded-full border border-foreground/10 bg-background px-3 py-1 text-xs font-semibold text-muted-foreground">
          <ZapIcon className="size-3.5 text-success" />
          Solana Developer Platform · Embedded Yield
        </p>
        <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-foreground lg:text-6xl">
          Give your customers yield with one code snippet.
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground lg:text-lg">
          Launch a B2B2C product or B2B2B stablecoin savings product with 24/7
          yields on the go.
        </p>
        <p className="mt-6 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <ArrowDownIcon className="size-4 animate-bounce" />
          Scroll to begin
        </p>
      </Reveal>
    </section>
  );
}

function StepLayout({
  id,
  children,
  visual,
}: {
  id: string;
  children: ReactNode;
  visual: ReactNode;
}) {
  return (
    <section
      id={id}
      data-step={id}
      className="mx-auto grid max-w-6xl scroll-mt-16 items-center gap-12 px-6 py-16 lg:min-h-[92vh] lg:grid-cols-2 lg:gap-8 lg:py-10"
    >
      <Reveal className="max-w-xl">{children}</Reveal>
      <Reveal delay={120} className="flex justify-center lg:justify-end">
        {visual}
      </Reveal>
    </section>
  );
}

function Kicker({ index, label }: { index: number; label: string }) {
  return (
    <p className="text-xs font-bold tracking-widest text-success uppercase">
      Step {index} · {label}
    </p>
  );
}

function CustodySection() {
  return (
    <StepLayout
      id="custody"
      visual={
        <PhoneFrame>
          <CustodyScreen />
        </PhoneFrame>
      }
    >
      <div className="text-left">
        <Kicker index={1} label="Wallet" />
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">
          It starts as an ordinary wallet app.
        </h2>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          Northstar is a small fintech with a consumer Wallet app.
        </p>
        <ul className="mt-5 space-y-2.5 text-sm">
          {[
            "USD, EUR, and USDC balances in one app",
            "Yield can be surfaced to anyone holding stablecoins",
            "Onramp fiat into stablecoins via Solana Developer Platform payments solution",
          ].map((line) => (
            <li key={line} className="flex items-start gap-2.5">
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
              <span className="text-foreground/80">{line}</span>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-sm text-muted-foreground">
          This screen replicates the demo customer from the reference example,
          re-built as a faux phone.
        </p>
      </div>
    </StepLayout>
  );
}

function ConfigureVisual() {
  return (
    <div className="flex w-full max-w-xl flex-col items-stretch gap-4">
      <DashboardPreview />
      <pre className="overflow-x-auto rounded-xl border border-foreground/10 bg-foreground p-4 text-xs leading-relaxed text-background">
        <code>{`POST /v1/earn/external-wallet/deposit-transactions
Authorization: Bearer <project-api-key>

{
  "strategyId": "treasury-4.8",
  "ownerAddress": "<customer-wallet>",
  "amount": "12500",
  "sourceTokenMint": "<usdc-mint>"
}`}</code>
      </pre>
    </div>
  );
}

function ConfigureSection() {
  return (
    <StepLayout id="configure" visual={<ConfigureVisual />}>
      <div className="text-left">
        <Kicker index={2} label="Configure" />
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">
          Pick the yield to surface — with one API request.
        </h2>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          The company opens the SDP dashboard&rsquo;s Embedded Yield page and
          chooses which Earn strategy to offer to its customers, while SDP
          handles the on-chain plumbing.
        </p>
        <p className="mt-6 text-sm font-semibold text-foreground">
          Bring your own signing infrastructure — or easily use one of ours.
        </p>
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-foreground/10 bg-background p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <KeyRoundIcon className="size-4 shrink-0 text-success" />
              Already support stables? Perfect.
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Bring your own signing infrastructure: SDP builds the transaction,
              your existing keys sign it, and your users keep whatever custody
              setup they already have.
            </p>
          </div>
          <div className="rounded-xl border border-foreground/10 bg-background p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CircleArrowDownIcon className="size-4 shrink-0 text-success" />
              Don&rsquo;t support stables or crypto yet?
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              SDP can handle it: on-ramp your users from fiat into stablecoins,
              and provision wallets through wallet solutions SDP integrates with
              — no crypto stack required.
            </p>
          </div>
        </div>
      </div>
    </StepLayout>
  );
}

function EarnSection() {
  return (
    <StepLayout id="earn" visual={<EarnDemo />}>
      <div className="text-left">
        <Kicker index={3} label="Earn" />
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">
          Press Earn, and the balance starts working.
        </h2>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          Back in the Wallet app, the customer&rsquo;s USDC now shows an
          &ldquo;Earn 8.43%&rdquo; button. One tap opts their stablecoins into
          the strategies the company surfaced in step 2.
        </p>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          Fast-forward 30 days: yield accrues daily as the vault lends its USDC
          through the Kamino Institutional Commodity Yield strategy,* and the
          balance chart ticks up and to the right. Positions, earnings, and the
          full movement history are all readable back from the Embedded Yield
          API.
        </p>
        <div className="mt-5 rounded-xl border border-foreground/10 bg-background p-3">
          <div className="flex items-start gap-2.5 text-sm">
            <LandmarkIcon className="mt-0.5 size-4 shrink-0 text-success" />
            <span className="text-foreground/80">
              Yield via the Kamino Institutional Commodity Yield strategy ·
              8.43% APY
            </span>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          *This tutorial uses the Kamino Institutional Commodity Yield strategy
          as its example — many other strategies are available too.
        </p>
      </div>
    </StepLayout>
  );
}

function StrategiesSection() {
  const strategies = [
    {
      name: "Kamino Institutional Commodity Yield",
      provider: "Kamino",
      asset: "USDC",
      apy: "8.43%",
    },
    {
      name: "Steakhouse High Yield USDC",
      provider: "Kamino",
      asset: "USDC",
      apy: "4.84%",
    },
    {
      name: "Steakhouse High Yield USDG",
      provider: "Kamino",
      asset: "USDG",
      apy: "4.34%",
    },
    {
      name: "WisdomTree Government Money Market Digital Fund",
      provider: "WisdomTree",
      asset: "WTGXX",
      apy: "3.61%",
    },
    {
      name: "Ondo USDY",
      provider: "Ondo",
      asset: "USDY",
      apy: "3.6%",
    },
    {
      name: "Steakhouse USDC",
      provider: "Kamino",
      asset: "USDC",
      apy: "3.41%",
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-10">
      <Reveal>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
          Mainnet strategies at a glance
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Pay with any of the supported stables: USDC, USDG, USDT, or PYUSD.
        </p>
        <div className="mt-5 overflow-x-auto rounded-xl border border-foreground/10 bg-background">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-xs tracking-wider text-muted-foreground uppercase">
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Strategy
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Provider
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Base Asset*
                </th>
                <th
                  scope="col"
                  className="px-4 py-2.5 text-right font-semibold"
                >
                  APY
                </th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => (
                <tr
                  key={strategy.name}
                  className="border-b border-foreground/5 last:border-0"
                >
                  <td className="px-4 py-2.5 font-medium text-foreground">
                    {strategy.name}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {strategy.provider}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {strategy.asset}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-success tabular-nums">
                    {strategy.apy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          *You can deposit from any of the supported stables — USDC, USDG, USDT,
          or PYUSD — and SDP routes it into the strategy&rsquo;s base asset.
          This table may not be exhaustive. APYs were pulled from live data on
          September 17th, 2026.
        </p>
      </Reveal>
    </section>
  );
}

export function App() {
  const [activeId, setActiveId] = useState(STEPS[0].id);

  // Highlight the nav item for whichever step crosses the middle of the screen.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    for (const step of STEPS) {
      const section = document.getElementById(step.id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-svh bg-app text-foreground">
      <StepNav activeId={activeId} />
      <main>
        <Hero />
        <CustodySection />
        <ConfigureSection />
        <EarnSection />
        <StrategiesSection />
      </main>
      <footer className="border-t border-foreground/10 px-6 py-10">
        <p className="mx-auto max-w-6xl text-xs leading-relaxed text-muted-foreground">
          Demo balances are fictional and rates are illustrative. 8.43% was the
          real mainnet Kamino Institutional Commodity Yield rate on September
          17th, 2026. For the real devnet integration — live balances,
          strategies, and movements — see{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            examples/embedded-yield-bank
          </code>{" "}
          in the solana-developer-platform repository.
        </p>
      </footer>
    </div>
  );
}

export default App;
