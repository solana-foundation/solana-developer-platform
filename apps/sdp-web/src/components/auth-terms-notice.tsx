import Link from "next/link";
import { getTranslations } from "@/i18n/server";

const TOS_HREF = "https://solana.com/tos";

export async function AuthTermsNotice() {
  const t = await getTranslations();

  return (
    <p className="text-meta text-tertiary">
      {t("Shared.authTerms.prefix")}{" "}
      <Link
        href={TOS_HREF}
        target="_blank"
        rel="noreferrer"
        className="text-secondary underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        {t("Shared.authTerms.link")}
      </Link>
      .
    </p>
  );
}
