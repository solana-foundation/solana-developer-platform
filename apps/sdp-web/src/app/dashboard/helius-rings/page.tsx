import { notFound } from "next/navigation";
import { heliusRings } from "@/flags";

export default async function HeliusRingsPage() {
  if (!(await heliusRings())) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-primary">Helius Rings</h1>
      <p className="mt-2 text-sm text-secondary">Coming soon.</p>
    </div>
  );
}
