import { redirect } from "next/navigation";

export default async function CustodySetupPage() {
  redirect("/dashboard/wallets");
}
