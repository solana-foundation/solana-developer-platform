import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-4xl items-center justify-between">
        <div>
          <p className="text-sm uppercase tracking-wide text-muted-foreground">SDP Console</p>
          <h1 className="text-2xl font-semibold">Access Control</h1>
        </div>
        <div className="flex items-center gap-3">
          <SignedOut>
            <SignInButton mode="modal">
              <Button>Sign in</Button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <UserButton />
          </SignedIn>
        </div>
      </div>

      <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Allowlist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Manage allowed emails and domains for access.</p>
            <SignedIn>
              <Link className="text-foreground underline" href="/allowlist">
                Open allowlist
              </Link>
            </SignedIn>
            <SignedOut>
              <p>Sign in to manage the allowlist.</p>
            </SignedOut>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Organization Invites</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Invite teammates into your organization.</p>
            <SignedIn>
              <Link className="text-foreground underline" href="/members">
                Open invites
              </Link>
            </SignedIn>
            <SignedOut>
              <p>Sign in to send invitations.</p>
            </SignedOut>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
