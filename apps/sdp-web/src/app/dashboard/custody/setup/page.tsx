import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { initializeCustody } from "../actions";
import { CustodySetupForm } from "./setup-form";

export default async function CustodySetupPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Create your master signing wallet</CardTitle>
          <CardDescription>
            This wallet will be used to sign API operations by default. You can create additional
            wallets later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <CustodySetupForm action={initializeCustody} />

          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-xs text-[rgba(28,28,29,0.64)]">
            This step provisions wallet signing for your organization. It does not automatically
            rotate on-chain authorities for existing assets.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
