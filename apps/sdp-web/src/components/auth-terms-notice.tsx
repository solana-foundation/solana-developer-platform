import Link from "next/link";
import { getTranslations } from "@/i18n/server";

const TOS_HREF = "https://solana.com/tos";

export async function AuthTermsNotice() {
  const t = await getTranslations();

  return (
    <p className="max-w-sm text-center text-xs leading-5 text-secondary">
      {t("Shared.authTerms.prefix")}{" "}
      <Link
        href={TOS_HREF}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline underline-offset-2 transition-colors hover:text-black"
      >
        {t("Shared.authTerms.link")}
      </Link>
      .
    </p>
  );
}
