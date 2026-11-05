import { refreshThemeProps } from "@sdp/design-tokens";
import { SDP_TERMS } from "@sdp/types/mainnet-access";
import type { Metadata } from "next";
import Link from "next/link";
import { SdpProductLockup } from "@/components/auth-page-shell";
import { SdpTermsContent } from "@/components/sdp-terms-content";
import { getTranslations } from "@/i18n/server";

export const metadata: Metadata = { title: SDP_TERMS.title };

/**
 * The public SDP Terms of Use (`SDP_TERMS_PATH`): the same text the mainnet access request asks an
 * organization to accept, so the page and the acceptance never disagree.
 */
export default async function TermsPage() {
  const t = await getTranslations();

  return (
    <main {...refreshThemeProps} className="min-h-dvh bg-surface px-4 pb-24 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <header className="flex h-18 items-center">
          <Link
            href="/"
            aria-label={t("Shared.termsPage.home")}
            className="rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
          >
            <SdpProductLockup productName={t("Shared.authShell.productName")} />
          </Link>
        </header>
        <article className="pt-10 text-body leading-7 text-secondary sm:pt-16">
          <h1 className="text-heading font-medium text-primary">{SDP_TERMS.title}</h1>
          <p className="mt-2 text-meta text-tertiary">{SDP_TERMS.effectiveDate}</p>
          <SdpTermsContent
            headings={{ section: "h2", subsection: "h3" }}
            className="mt-10 border-t border-border-default pt-10 [overflow-wrap:anywhere]"
          />
        </article>
      </div>
    </main>
  );
}
