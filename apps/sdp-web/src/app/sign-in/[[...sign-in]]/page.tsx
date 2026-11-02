import { SignIn } from "@clerk/nextjs";
import { authAppearance } from "@/components/auth-appearance";
import { AuthPageShell } from "@/components/auth-page-shell";
import { waitlistHref } from "@/components/homepage/homepage-links";
import { homepageOpenSignup } from "@/flags";
import { getTranslations } from "@/i18n/server";

export default async function SignInPage() {
  const [t, openSignup] = await Promise.all([getTranslations(), homepageOpenSignup()]);
  const action = openSignup
    ? { href: "/sign-up", label: t("Homepage.cta.createAccount"), external: false }
    : { href: waitlistHref, label: t("Shared.authShell.requestAccess"), external: true };

  return (
    <AuthPageShell action={action}>
      <SignIn routing="path" path="/sign-in" appearance={authAppearance} />
    </AuthPageShell>
  );
}
