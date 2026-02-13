import type { LucideIcon } from "lucide-react";
import { ArrowLeftRight, Coins, KeyRound, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

type DashboardCard = {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
};

const dashboardCards: DashboardCard[] = [
  {
    href: "/dashboard/wallets",
    icon: Wallet,
    title: "Wallets",
    description: "Set provider and wallet signers",
  },
  {
    href: "/dashboard/issuance",
    icon: Coins,
    title: "Issuance",
    description: "Issue and manage token assets",
  },
  {
    href: "/dashboard/payments",
    icon: ArrowLeftRight,
    title: "Payments",
    description: "Move funds and track transfers",
  },
  {
    href: "/dashboard/api-keys",
    icon: KeyRound,
    title: "API keys",
    description: "Configure auth credentials",
  },
];

export default function DashboardPage() {
  return (
    <div className="relative flex min-h-[calc(100vh-120px)] flex-col items-center justify-center px-3 pt-6 md:px-0">
      <div className="flex items-center gap-3">
        <p className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[rgba(28,28,29,0.72)]">
          Get started with
        </p>
        <div className="flex items-center gap-2">
          <Image src="/landing/solana-logo.svg" alt="Solana" width={20} height={20} />
          <p className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">
            SDP
          </p>
        </div>
      </div>

      <div className="mt-6 grid w-full max-w-[720px] gap-3 sm:grid-cols-2">
        {dashboardCards.map((card) => {
          const Icon = card.icon;

          return (
            <Link
              key={card.href}
              href={card.href}
              className="rounded-[16px] border border-[rgba(28,28,29,0.10)] bg-white p-6 transition hover:bg-[rgba(28,28,29,0.03)]"
            >
              <Icon className="h-6 w-6 text-[rgba(28,28,29,0.8)]" />
              <div className="mt-5 space-y-1">
                <h2 className="text-[19px] leading-[24px] font-medium tracking-[-0.2px] text-[#1c1c1d]">
                  {card.title}
                </h2>
                <p className="text-[16px] leading-[24px] text-[rgba(28,28,29,0.72)]">
                  {card.description}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
