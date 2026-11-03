import { SignUp } from "@clerk/nextjs";
import { authAppearance } from "@/components/auth-appearance";
import { AuthPageShell } from "@/components/auth-page-shell";
import { AuthTermsNotice } from "@/components/auth-terms-notice";
import { getTranslations } from "@/i18n/server";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/clerk-config";

export default async function SignUpPage() {
  const t = await getTranslations();

  return (
    <AuthPageShell
      action={{ href: SIGN_IN_PATH, label: t("Homepage.cta.signIn"), external: false }}
    >
      <SignUp routing="path" path={SIGN_UP_PATH} appearance={authAppearance} />
      <AuthTermsNotice />
    </AuthPageShell>
  );
}
