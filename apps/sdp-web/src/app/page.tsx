import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import Image from "next/image";
import Link from "next/link";
import { HomepageCtas } from "@/components/homepage-ctas";
import { LanguagePicker } from "@/components/language-picker";
import { homepageOpenSignup } from "@/flags";
import { getTranslations } from "@/i18n/server";

const docsHref =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:3001/docs" : DEFAULT_SDP_DOCS_URL);
export default async function Home() {
  const [t, openSignup] = await Promise.all([getTranslations(), homepageOpenSignup()]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-surface to-surface-sunken text-primary">
      <header className="border-b border-border-subtle">
        <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between px-6 xl:px-0">
          <Image
            data-testid="landing-solana-logo"
            src="/landing/solana-logo.svg"
            alt={t("Home.solanaLogo")}
            width={20}
            height={18}
            className="dark:invert"
          />
          <div className="flex items-center gap-2">
            <Link
              href={docsHref}
              className="mr-2 text-sm font-medium text-secondary transition-colors hover:text-primary"
            >
              {t("Home.docs")}
            </Link>
            <LanguagePicker variant="landing" />
            <Link
              href="/sign-in"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-semibold text-on-primary transition hover:opacity-90"
            >
              {t("Home.dashboard")}
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto grid min-h-[calc(100vh-72px)] max-w-[1200px] gap-12 px-6 pb-28 pt-16 md:pt-20 lg:grid-cols-[568px_1fr] lg:items-center lg:gap-6 xl:px-0 xl:pt-24">
        <div>
          <h1 className="max-w-[560px] text-balance text-[42px] font-medium leading-[0.98] tracking-[-0.5px] md:text-[56px]">
            {t("Home.title")}
          </h1>

          <p className="mt-[26px] max-w-[510px] text-[16px] font-[450] leading-6 text-secondary">
            {t("Home.description")}
          </p>

          <HomepageCtas
            contactUsLabel={t("Home.contactUs")}
            joinWaitlistLabel={t("Home.joinWaitlist")}
            openSignup={openSignup}
            trySdpLabel={t("Home.trySdp")}
          />
        </div>

        <div
          className="relative hidden h-[470px] w-full overflow-visible lg:block"
          aria-hidden="true"
        >
          <div className="absolute right-[8px] top-0 flex h-[443px] w-[625px] items-center">
            <div className="relative h-[443px] w-[313px]">
              <Image
                data-testid="landing-hero-figure"
                src="/landing/hero-figure.svg"
                alt=""
                width={313}
                height={443}
                className="h-full w-full dark:invert"
              />
            </div>

            <div className="relative ml-[-1px] flex h-[443px] w-[313px] items-center justify-center">
              <Image
                src="/landing/hero-plate.svg"
                alt=""
                width={313}
                height={443}
                className="h-full w-full dark:invert"
              />
            </div>

            <div className="absolute left-0 top-[-75px] h-[60px] w-px bg-border-strong" />
            <div className="absolute left-0 top-[281px] h-[299px] w-px bg-border-strong" />
            <div className="absolute right-0 top-[447px] h-[137px] w-px bg-border-strong" />
          </div>
        </div>
      </section>
    </main>
  );
}
