import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#e9e7de] to-[#f5f4ef] px-6 text-center text-[#1c1c1d]">
      <Image src="/landing/solana-logo.svg" alt="Solana" width={24} height={22} />

      <p className="mt-10 text-7xl font-medium leading-none tracking-tight">404</p>

      <h1 className="mt-5 text-2xl font-medium tracking-tight">Page not found</h1>

      <p className="mt-3 max-w-[420px] text-base leading-6 text-[rgba(28,28,29,0.72)]">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>

      <div className="mt-8 flex items-center gap-3">
        <Button asChild>
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </main>
  );
}
