import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--background)] px-6">
      <SignUp />
    </div>
  );
}
