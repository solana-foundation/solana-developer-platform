import {
  OrganizationSwitcher,
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

const primaryButtonClass =
  "text-button-lg inline-flex h-[var(--button-height-lg)] items-center justify-center rounded-[var(--button-radius-lg)] bg-[color:var(--button-primary-bg)] px-[var(--button-padding-x-lg)] text-[color:var(--button-primary-text)] transition-colors hover:bg-[color:var(--button-primary-bg-hover)]";

const secondaryButtonClass =
  "text-button-lg inline-flex h-[var(--button-height-lg)] items-center justify-center rounded-[var(--button-radius-lg)] border border-[color:var(--border-light)] bg-[color:var(--button-secondary-bg)] px-[var(--button-padding-x-lg)] text-[color:var(--button-secondary-text)] transition-colors hover:bg-[color:var(--button-secondary-bg-hover)]";

function PrimaryButton({
  children,
  type = "button",
}: {
  children: React.ReactNode;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={primaryButtonClass}>
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  type = "button",
}: {
  children: React.ReactNode;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={secondaryButtonClass}>
      {children}
    </button>
  );
}

export default async function Home() {
  const { userId, orgId } = await auth();

  if (userId && orgId) {
    redirect("/dashboard");
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[color:var(--background)] text-[color:var(--text-high)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 right-[-10%] h-[420px] w-[420px] rounded-full bg-[color:var(--gray-200)] blur-[120px]" />
        <div className="absolute bottom-[-30%] left-[-5%] h-[520px] w-[520px] rounded-full bg-[color:var(--gray-100)] blur-[160px]" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-10">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--gray-1400)] text-sm font-semibold text-[color:var(--white)]">
              S
            </span>
            <div>
              <p className="text-body-sm uppercase tracking-[0.18em] text-[color:var(--text-low)]">
                Solana Developer Platform
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SignedIn>
              <OrganizationSwitcher hidePersonal />
              <UserButton />
            </SignedIn>
            <SignedOut>
              <SignInButton mode="modal">
                <SecondaryButton>Sign in</SecondaryButton>
              </SignInButton>
            </SignedOut>
          </div>
        </header>

        <div className="mt-16 grid flex-1 gap-12 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="flex flex-col gap-6">
            <p className="text-body-md uppercase tracking-[0.2em] text-[color:var(--text-low)]">
              Enterprise launchpad
            </p>
            <h1 className="text-display max-w-xl text-balance">
              A unified platform for building on Solana.
            </h1>
            <p className="text-body-lg max-w-xl text-[color:var(--text-medium)]">
              SDP brings issuance, payments, and trading workflows into a single API
              layer. Build, test, and launch production-grade Solana products with
              the partners and controls your team already uses.
            </p>

            <div className="mt-6 grid gap-3 text-body-md text-[color:var(--text-medium)]">
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-[color:var(--gray-900)]" />
                Sandbox + beta environments on devnet
              </div>
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-[color:var(--gray-900)]" />
                Invite-only access with org-based controls
              </div>
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-[color:var(--gray-900)]" />
                Designed for enterprise governance and security
              </div>
            </div>
          </section>

          <section className="flex items-center">
            <div className="w-full rounded-[28px] border border-[color:var(--border-light)] bg-[color:var(--white)]/70 p-8 shadow-[0_24px_60px_rgba(15,15,15,0.08)] backdrop-blur">
              <SignedOut>
                <h2 className="text-title-md">Join the waitlist</h2>
                <p className="text-body-md mt-3 text-[color:var(--text-medium)]">
                  SDP is invite-only for now. Share your work email and we will
                  follow up with access details.
                </p>
                <form className="mt-6 grid gap-4">
                  <label className="text-body-sm text-[color:var(--text-low)]">
                    Work email
                    <input
                      type="email"
                      placeholder="you@company.com"
                      className="mt-2 w-full rounded-[14px] border border-[color:var(--border-light)] bg-[color:var(--white)] px-4 py-3 text-body-md text-[color:var(--text-high)] outline-none transition focus:border-[color:var(--border-strong)]"
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <PrimaryButton type="button">Request access</PrimaryButton>
                    <SignUpButton mode="modal">
                      <SecondaryButton>I have an invite</SecondaryButton>
                    </SignUpButton>
                  </div>
                  <p className="text-body-sm text-[color:var(--text-low)]">
                    Prefer a direct intro? Email <span className="text-[color:var(--text-high)]">sdp@solana.org</span>
                  </p>
                </form>
              </SignedOut>

              <SignedIn>
                {!orgId && (
                  <>
                    <h2 className="text-title-md">Select your organization</h2>
                    <p className="text-body-md mt-3 text-[color:var(--text-medium)]">
                      Choose or create an organization to continue.
                    </p>
                    <div className="mt-6">
                      <OrganizationSwitcher hidePersonal />
                    </div>
                  </>
                )}
                {orgId && (
                  <p className="text-body-md text-[color:var(--text-medium)]">
                    Loading your dashboard…
                  </p>
                )}
              </SignedIn>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
