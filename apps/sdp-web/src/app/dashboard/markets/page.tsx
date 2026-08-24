import { notFound } from "next/navigation";
import { earn } from "@/flags";
import { MarketsLanding } from "./markets-landing";

/** Both paths this page offers gate on earn, so the chooser inherits the same gate rather than rendering two dead cards. */
export default async function MarketsPage() {
  if (!(await earn())) notFound();
  return <MarketsLanding />;
}
