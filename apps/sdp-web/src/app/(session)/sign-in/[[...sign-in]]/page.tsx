import { SignIn } from "@clerk/nextjs";
import { authAppearance } from "@/components/auth-appearance";
import { AuthPageShell } from "@/components/auth-page-shell";
import { AuthTermsNotice } from "@/components/auth-terms-notice";
import { hostedSandboxSignUpHref, waitlistHref } from "@/components/homepage/homepage-links";
import { homepageOpenSignup, sandboxOnBeta } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/clerk-config";

export default async function SignInPage() {
  const [t, openSignup, hostedSandbox] = await Promise.all([
    getTranslations(),
    homepageOpenSignup(),
    sandboxOnBeta(),
  ]);
  const action = openSignup
    ? { href: SIGN_UP_PATH, label: t("Homepage.cta.createAccount"), external: false }
    : { href: waitlistHref, label: t("Shared.authShell.requestAccess"), external: true };
  const secondaryAction = hostedSandbox
    ? { href: hostedSandboxSignUpHref(), label: t("Homepage.cta.trySandbox"), external: true }
    : null;

  return (
    <AuthPageShell action={action} secondaryAction={secondaryAction}>
      <SignIn routing="path" path={SIGN_IN_PATH} appearance={authAppearance} />
      <AuthTermsNotice />
    </AuthPageShell>
  );
}
