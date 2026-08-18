"use client";

import {
  ArrowLeftRightIcon,
  ChevronDownIcon,
  CoinsIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  TrendingUpIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const DEMO_TREASURY_PATH = "/demo/markets/treasury-solutions";
const DEMO_EARN_PATH = "/demo/markets/earn";

function StaticNavItem({ icon: Icon, label }: { icon: typeof LayoutDashboardIcon; label: string }) {
  return (
    <div className="flex h-10 items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-base text-secondary">
      <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.9} />
      <span>{label}</span>
    </div>
  );
}

export function MarketsDemoShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations();
  const [marketsOpen, setMarketsOpen] = useState(true);
  const onTreasury = pathname === DEMO_TREASURY_PATH;
  const onEarnBuilder = pathname === `${DEMO_EARN_PATH}/button-builder`;
  const onEarn = pathname === DEMO_EARN_PATH || pathname.startsWith(`${DEMO_EARN_PATH}/`);
  const title = t(
    onEarnBuilder
      ? "Shared.dashboardShell.configureEarnButton"
      : onEarn
        ? "Shared.dashboardShell.earnProgram"
        : "Shared.dashboardShell.treasurySolutions"
  );

  return (
    <main className="h-screen min-h-screen overflow-hidden bg-[var(--sdp-shell-bg)] text-primary">
      <div className="mx-auto grid h-full min-h-screen w-full max-w-none grid-cols-[296px_1fr] gap-0">
        <aside className="relative z-10 flex h-screen w-[296px] flex-col justify-between bg-[var(--sdp-shell-bg)]">
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-3">
            <div className="py-3">
              <div className="flex h-12 items-center gap-3 rounded-xl border border-border-default bg-surface-raised px-3 shadow-sm">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-on-primary">
                  {t("DashboardMarkets.treasury.demoProjectInitials")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-primary">
                    {t("DashboardMarkets.treasury.demoProject")}
                  </span>
                  <span className="block text-xs text-tertiary">
                    {t("DashboardMarkets.treasury.demoEnvironment")}
                  </span>
                </span>
                <ChevronDownIcon aria-hidden="true" className="size-4 text-tertiary" />
              </div>
            </div>

            <nav
              aria-label={t("DashboardMarkets.treasury.primaryNavigation")}
              className="space-y-6"
            >
              <div className="space-y-2">
                <p className="px-3 text-xs uppercase leading-normal tracking-wide text-muted">
                  {t("DashboardMarkets.treasury.create")}
                </p>
                <div className="space-y-0.5">
                  <StaticNavItem
                    icon={LayoutDashboardIcon}
                    label={t("DashboardMarkets.treasury.home")}
                  />
                  <StaticNavItem icon={WalletIcon} label={t("DashboardMarkets.treasury.wallets")} />
                </div>
              </div>

              <div className="space-y-2 border-t border-border-subtle pt-6">
                <p className="px-3 text-xs uppercase leading-normal tracking-wide text-muted">
                  {t("DashboardMarkets.treasury.manage")}
                </p>
                <div className="space-y-0.5">
                  <StaticNavItem icon={CoinsIcon} label={t("DashboardMarkets.treasury.issuance")} />
                  <StaticNavItem
                    icon={ArrowLeftRightIcon}
                    label={t("DashboardMarkets.treasury.payments")}
                  />

                  <div>
                    <div className="relative flex items-center">
                      <Link
                        className="flex h-10 w-full items-center gap-3 rounded-[var(--button-radius-lg)] border border-border-subtle bg-surface-raised px-3 pr-11 text-base text-primary"
                        href={DEMO_TREASURY_PATH}
                      >
                        <TrendingUpIcon
                          aria-hidden="true"
                          className="size-5 shrink-0"
                          strokeWidth={1.9}
                        />
                        <span>{t("DashboardMarkets.treasury.markets")}</span>
                      </Link>
                      <button
                        aria-controls="markets-demo-subnav"
                        aria-expanded={marketsOpen}
                        aria-label={t(
                          marketsOpen
                            ? "Shared.dashboardShell.collapseSectionMenu"
                            : "Shared.dashboardShell.expandSectionMenu",
                          { section: t("DashboardMarkets.treasury.markets") }
                        )}
                        className="absolute right-1 inline-flex size-9 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-fill-strong hover:text-primary"
                        onClick={() => setMarketsOpen((open) => !open)}
                        type="button"
                      >
                        <ChevronDownIcon
                          aria-hidden="true"
                          className={cn(
                            "size-4 transition-transform motion-reduce:transition-none",
                            !marketsOpen && "-rotate-90"
                          )}
                        />
                      </button>
                    </div>

                    {marketsOpen ? (
                      <div className="ml-5 mt-2" id="markets-demo-subnav">
                        {[
                          {
                            active: onTreasury,
                            href: DEMO_TREASURY_PATH,
                            label: t("Shared.dashboardShell.treasurySolutions"),
                          },
                          {
                            active: onEarn,
                            href: DEMO_EARN_PATH,
                            label: t("Shared.dashboardShell.earnProgram"),
                          },
                        ].map((item, index, items) => (
                          <div className="flex gap-2" key={item.href}>
                            <div
                              className={cn(
                                "w-0.5 shrink-0 self-stretch transition-colors",
                                index === 0 && "mt-1",
                                index === items.length - 1 && "mb-1",
                                item.active ? "bg-secondary" : "bg-fill-strong"
                              )}
                            />
                            <Link
                              aria-current={item.active ? "page" : undefined}
                              className={cn(
                                "flex h-9 flex-1 items-center rounded-lg px-3 text-sm transition-colors",
                                item.active
                                  ? "border border-border-subtle bg-surface-raised text-primary"
                                  : "text-secondary hover:bg-fill-strong hover:text-primary"
                              )}
                              href={item.href}
                            >
                              {item.label}
                            </Link>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <StaticNavItem
                    icon={KeyRoundIcon}
                    label={t("DashboardMarkets.treasury.apiKeys")}
                  />
                </div>
              </div>
            </nav>
          </div>

          <div className="border-t border-border-subtle px-6 py-4 text-xs text-tertiary">
            {t("DashboardMarkets.treasury.demoLabel")}
          </div>
        </aside>

        <section className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl rounded-tr-none border border-border-subtle bg-surface-raised/80">
          <header className="relative flex shrink-0 items-center justify-center border-b border-border-default px-6 pt-6 pb-5">
            <h1 className="text-xl font-medium tracking-tight text-primary">{title}</h1>
          </header>
          <div className="min-h-0 flex-1">{children}</div>
        </section>
      </div>
    </main>
  );
}
