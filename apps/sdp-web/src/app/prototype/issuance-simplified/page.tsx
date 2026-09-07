import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { IssuanceSimplifiedPrototype } from "./issuance-simplified-prototype";

export const metadata: Metadata = {
  title: "Simplified issuance prototype",
};

export default function SimplifiedIssuancePrototypePage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <Suspense>
      <IssuanceSimplifiedPrototype />
    </Suspense>
  );
}
