import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";

export default async function NotFound() {
  const t = await getTranslations();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#e9e7de] to-[#f5f4ef] px-6 text-center text-[#1c1c1d]">
      <Image src="/landing/solana-logo.svg" alt={t("NotFound.solanaLogo")} width={24} height={22} />

      <p className="mt-10 text-7xl font-medium leading-none tracking-tight">404</p>

      <h1 className="mt-5 text-2xl font-medium tracking-tight">{t("NotFound.title")}</h1>

      <p className="mt-3 max-w-[420px] text-base leading-6 text-[rgba(28,28,29,0.72)]">
        {t("NotFound.description")}
      </p>

      <div className="mt-8 flex items-center gap-3">
        <Button asChild>
          <Link href="/dashboard">{t("NotFound.backToDashboard")}</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">{t("NotFound.goHome")}</Link>
        </Button>
      </div>
    </main>
  );
}
