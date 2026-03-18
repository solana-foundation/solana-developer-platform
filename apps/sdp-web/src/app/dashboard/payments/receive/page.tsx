import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PaymentsActionPage } from "../payments-action-page";

export default async function PaymentsReceivePage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <PaymentsActionPage mode="receive" wallets={[]} walletsError={null} />;
}
