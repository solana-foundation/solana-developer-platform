import { SDP_TERMS_PATH } from "@sdp/types/site";
import Link from "next/link";
import { getTranslations } from "@/i18n/server";

export async function AuthTermsNotice() {
  const t = await getTranslations();

  return (
    <p className="text-meta text-tertiary">
      {t("Shared.authTerms.prefix")}{" "}
      <Link
        href={SDP_TERMS_PATH}
        className="text-secondary underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        {t("Shared.authTerms.link")}
      </Link>
      .
    </p>
  );
}
