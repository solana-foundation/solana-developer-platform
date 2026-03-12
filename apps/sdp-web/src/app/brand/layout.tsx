import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Brand - Solana Developer Platform",
  description: "Solana Developer Platform brand guidelines and assets",
};

export default function BrandLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[#e9e7de] text-[#1c1c1d]">
      {/* Header */}
      <header className="border-b border-[rgba(28,28,29,0.08)]">
        <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between px-6 xl:px-0">
          <Link href="/" className="transition-opacity hover:opacity-70">
            <Image src="/landing/solana-logo.svg" alt="Solana" width={20} height={18} />
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="/brand"
              className="text-[14px] font-medium text-[rgba(28,28,29,0.72)] transition-colors hover:text-[#1c1c1d]"
            >
              Overview
            </Link>
            <Link
              href="/"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.08)] px-3 text-sm font-semibold text-[#1c1c1d] transition-colors hover:bg-[rgba(28,28,29,0.14)]"
            >
              Back to home
            </Link>
          </nav>
        </div>
      </header>

      {/* Content */}
      <div className="mx-auto max-w-[1200px] px-6 pb-24 pt-16 xl:px-0">
        {children}
      </div>
    </main>
  );
}
