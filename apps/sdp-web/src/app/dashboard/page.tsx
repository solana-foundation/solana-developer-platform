import { ArrowLeftRight, Coins, KeyRound, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

export default function DashboardPage() {
  return (
    <div className="flex h-full flex-col">
      <h2 className="text-[38px] leading-[1.02] font-medium tracking-[-0.35px]">Workspace</h2>

      <div className="flex flex-1 flex-col items-center justify-center pb-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-[rgba(28,28,29,0.10)] bg-white shadow-[0_10px_20px_rgba(28,28,29,0.05)]">
          <Image src="/landing/solana-logo.svg" alt="Solana" width={28} height={25} />
        </div>

        <h3 className="mt-8 text-center text-[46px] leading-[1.02] font-medium tracking-[-0.45px]">
          Build with SDP
        </h3>

        <div className="mt-8 grid w-full max-w-[860px] gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/dashboard/wallets"
            className="rounded-xl border border-[rgba(28,28,29,0.10)] bg-white p-3 text-sm transition hover:bg-[rgba(28,28,29,0.03)]"
          >
            <div className="flex items-center gap-2 font-medium">
              <Wallet className="h-4 w-4" />
              Wallets
            </div>
            <p className="mt-1 text-[rgba(28,28,29,0.64)]">Set provider and wallet signers</p>
          </Link>

          <Link
            href="/dashboard/issuance"
            className="rounded-xl border border-[rgba(28,28,29,0.10)] bg-white p-3 text-sm transition hover:bg-[rgba(28,28,29,0.03)]"
          >
            <div className="flex items-center gap-2 font-medium">
              <Coins className="h-4 w-4" />
              Issuance
            </div>
            <p className="mt-1 text-[rgba(28,28,29,0.64)]">Issue and manage token assets</p>
          </Link>

          <Link
            href="/dashboard/payments"
            className="rounded-xl border border-[rgba(28,28,29,0.10)] bg-white p-3 text-sm transition hover:bg-[rgba(28,28,29,0.03)]"
          >
            <div className="flex items-center gap-2 font-medium">
              <ArrowLeftRight className="h-4 w-4" />
              Payments
            </div>
            <p className="mt-1 text-[rgba(28,28,29,0.64)]">Move funds and track transfers</p>
          </Link>

          <Link
            href="/dashboard/api-keys"
            className="rounded-xl border border-[rgba(28,28,29,0.10)] bg-white p-3 text-sm transition hover:bg-[rgba(28,28,29,0.03)]"
          >
            <div className="flex items-center gap-2 font-medium">
              <KeyRound className="h-4 w-4" />
              API keys
            </div>
            <p className="mt-1 text-[rgba(28,28,29,0.64)]">Configure auth credentials</p>
          </Link>
        </div>
      </div>
    </div>
  );
}
