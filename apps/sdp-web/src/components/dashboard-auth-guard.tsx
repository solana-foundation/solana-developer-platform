import { OrganizationSwitcher, SignInButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import type { ReactNode } from "react";

export async function DashboardAuthGuard({ children }: { children: ReactNode }) {
  const { userId, orgId } = await auth();

  if (!userId) {
    return (
      <main className="min-h-screen bg-[#e9e7de] p-0 text-[#1c1c1d]">
        <div className="mx-auto max-w-3xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            Sign in to continue
          </h1>
          <p className="mt-3 text-sm text-[rgba(28,28,29,0.64)]">
            Access your organization workspace and wallet controls.
          </p>
          <div className="mt-6">
            <SignInButton mode="modal">
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-[10px] bg-[#0f0f10] px-[18px] text-[15px] font-semibold leading-[15px] text-white transition-colors hover:bg-black"
              >
                Sign in
              </button>
            </SignInButton>
          </div>
        </div>
      </main>
    );
  }

  if (!orgId) {
    return (
      <main className="min-h-screen bg-[#e9e7de] p-0 text-[#1c1c1d]">
        <div className="mx-auto max-w-3xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            Select an organization
          </h1>
          <p className="mt-3 text-sm text-[rgba(28,28,29,0.64)]">
            You need an organization to continue.
          </p>
          <div className="mt-6">
            <OrganizationSwitcher hidePersonal />
          </div>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
