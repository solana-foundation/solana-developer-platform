import { SignUp } from "@clerk/nextjs";
import { authAppearance } from "@/components/auth-appearance";
import { AuthPageShell } from "@/components/auth-page-shell";
import { getTranslations } from "@/i18n/server";
import { AUTH_ENTRY_PATH } from "@/lib/auth-entry";

export default async function SignUpPage() {
  const t = await getTranslations();

  return (
    <AuthPageShell
      action={{ href: AUTH_ENTRY_PATH, label: t("Homepage.cta.signIn"), external: false }}
    >
      <SignUp routing="path" path="/sign-up" appearance={authAppearance} />
    </AuthPageShell>
  );
}
