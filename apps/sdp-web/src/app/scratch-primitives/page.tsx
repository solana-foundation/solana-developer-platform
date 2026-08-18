"use client";

// LOCAL QA ONLY - not committed to any PR branch. Delete when you're done looking.
import { Callout } from "@/components/ui/callout";
import { DefinitionTerm } from "@/components/ui/definition-term";
import { DocLink } from "@/components/ui/doc-link";

const VARIANTS = ["info", "success", "warning", "danger"] as const;

export default function ScratchPrimitivesPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-10">
      <section className="space-y-4">
        <h1 className="text-2xl font-medium text-primary">Callout</h1>
        {VARIANTS.map((variant) => (
          <Callout key={variant} title={`${variant} callout`} variant={variant}>
            Sending 250.00 USDC to Acme Ltd. The network fee is 0.00015 SOL and this cannot be
            undone once signed.
          </Callout>
        ))}
        <Callout live variant="danger">
          This one is `live`, so it announces itself when it appears in response to an action.
        </Callout>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-primary">DefinitionTerm and DocLink</h2>
        <p className="text-base text-primary">
          A{" "}
          <DefinitionTerm
            definition="The on-chain account that defines a token and its total supply."
            term="mint"
          />{" "}
          is created once per token, and its{" "}
          <DefinitionTerm
            definition="How many places the smallest unit of the token divides into. Fixed at creation."
            term="decimals"
          />{" "}
          cannot be changed afterwards. The{" "}
          <DefinitionTerm
            definition="The account that pays the network fee for a transaction. It does not have to be the sender."
            term="fee payer"
          />{" "}
          is charged in SOL.{" "}
          <DocLink newTabHint="opens in a new tab" path="/reference/policies">
            Read the reference
          </DocLink>
        </p>
        <p className="text-sm text-tertiary">
          Tab to a dotted term to open it with the keyboard, then press Escape to dismiss.
        </p>
      </section>
    </main>
  );
}
