import { SignUp } from "@clerk/nextjs";
import { AuthTermsNotice } from "@/components/auth-terms-notice";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-surface to-surface-sunken px-6 py-10">
      <div className="flex flex-col items-center gap-4">
        <SignUp routing="path" path="/sign-up" />
        <AuthTermsNotice />
      </div>
    </div>
  );
}
