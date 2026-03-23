import { isAuthEntryEnabled } from "@/lib/auth-entry";
import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";

export default function SignInPage() {
  if (!isAuthEntryEnabled()) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#e9e7de] to-[#f5f4ef] px-6 py-10">
      <SignIn routing="path" path="/sign-in" />
    </div>
  );
}
