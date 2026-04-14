import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import Image from "next/image";
import Link from "next/link";

const docsHref =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:3001/docs" : DEFAULT_SDP_DOCS_URL);
const waitlistHref = "https://solanafoundation.typeform.com/to/PLfMTDQs";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-[#e9e7de] to-[#f5f4ef] text-[#1c1c1d]">
      <header className="border-b border-[rgba(28,28,29,0.08)]">
        <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between px-6 xl:px-0">
          <Image src="/landing/solana-logo.svg" alt="Solana" width={20} height={18} />
          <div className="flex items-center gap-5">
            <Link
              href={docsHref}
              className="text-sm font-medium text-[rgba(28,28,29,0.72)] transition-colors hover:text-[#1c1c1d]"
            >
              Docs
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-[#0f0f10] px-3 text-sm font-semibold text-white transition-colors hover:bg-black"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto grid min-h-[calc(100vh-72px)] max-w-[1200px] gap-12 px-6 pb-28 pt-16 md:pt-20 lg:grid-cols-[568px_1fr] lg:items-center lg:gap-6 xl:px-0 xl:pt-24">
        <div>
          <h1 className="max-w-[560px] text-balance text-[42px] font-medium leading-[0.98] tracking-[-0.5px] md:text-[56px]">
            Build any financial product, without worrying about the infrastructure
          </h1>

          <p className="mt-[26px] max-w-[510px] text-[16px] font-[450] leading-6 text-[rgba(28,28,29,0.72)]">
            Whether you&apos;re issuing a stablecoin, orchestrating cross-border payments, or
            tokenizing real-world assets, SDP provides the most reliable APIs and infrastructure to
            make it happen.
          </p>

          <div className="mt-[34px]">
            <Link
              href={waitlistHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center justify-center rounded-[10px] bg-[#0f0f10] px-[18px] text-[15px] font-semibold leading-[15px] text-white transition-colors hover:bg-black"
            >
              Join the waitlist
            </Link>
          </div>
        </div>

        <div
          className="relative hidden h-[470px] w-full overflow-visible lg:block"
          aria-hidden="true"
        >
          <div className="absolute right-[8px] top-0 flex h-[443px] w-[625px] items-center">
            <div className="relative h-[443px] w-[313px]">
              <Image
                src="/landing/hero-figure.svg"
                alt=""
                width={313}
                height={443}
                className="h-full w-full"
              />
            </div>

            <div className="relative ml-[-1px] flex h-[443px] w-[313px] items-center justify-center">
              <Image
                src="/landing/hero-plate.svg"
                alt=""
                width={313}
                height={443}
                className="h-full w-full"
              />
            </div>

            <div className="absolute left-0 top-[-75px] h-[60px] w-px bg-[rgba(28,28,29,0.2)]" />
            <div className="absolute left-0 top-[281px] h-[299px] w-px bg-[rgba(28,28,29,0.2)]" />
            <div className="absolute right-0 top-[447px] h-[137px] w-px bg-[rgba(28,28,29,0.2)]" />
          </div>
        </div>
      </section>
    </main>
  );
}
