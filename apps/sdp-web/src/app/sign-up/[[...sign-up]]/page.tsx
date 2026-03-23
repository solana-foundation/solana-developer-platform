import { isAuthEntryEnabled } from "@/lib/auth-entry";
import { SignUp } from "@clerk/nextjs";
import { redirect } from "next/navigation";

export default function SignUpPage() {
  if (!isAuthEntryEnabled()) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#e9e7de] to-[#f5f4ef] px-6 py-10">
      <SignUp />
    </div>
  );
}
