import { SignUp } from "@clerk/nextjs";
import { AuthTermsNotice } from "@/components/auth-terms-notice";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#e9e7de] to-[#f5f4ef] px-6 py-10">
      <div className="flex flex-col items-center gap-4">
        <SignUp />
        <AuthTermsNotice />
      </div>
    </div>
  );
}
