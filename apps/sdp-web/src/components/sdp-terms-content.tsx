import { SDP_TERMS, type SdpTermsBlock, sdpTermsRuns } from "@sdp/types/mainnet-access";
import { cn } from "@sdp/ui/cn";

/** Heading levels for a section and its subsections, so the text nests under its host's own heading. */
type HeadingLevels = { section: "h2" | "h4"; subsection: "h3" | "h5" };

/**
 * The SDP Terms of Use (`SDP_TERMS`) as Legal wrote them: every section, subsection, list and bold
 * run, in the order of the source. The `/terms` page and the mainnet access reader both draw it,
 * so the text an admin accepts is the text the public page shows.
 */
export function SdpTermsContent({
  headings,
  className,
}: {
  headings: HeadingLevels;
  className?: string;
}) {
  const Section = headings.section;
  return (
    <div className={cn("space-y-8", className)}>
      {SDP_TERMS.sections.map((section) => (
        <section key={section.heading} className="space-y-3">
          <Section className="text-base font-medium text-primary">{section.heading}</Section>
          {section.blocks.map((block) => (
            <TermsBlock key={termsBlockKey(block)} block={block} subheading={headings.subsection} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** A block's text is unique within its section, so it keys the block. */
function termsBlockKey(block: SdpTermsBlock): string {
  return block.kind === "list" ? `list:${block.items[0]}` : `${block.kind}:${block.text}`;
}

function TermsBlock({ block, subheading }: { block: SdpTermsBlock; subheading: "h3" | "h5" }) {
  switch (block.kind) {
    case "subheading": {
      const Subheading = subheading;
      return (
        <Subheading className="pt-2 font-medium text-primary underline underline-offset-4">
          {block.text}
        </Subheading>
      );
    }
    case "list":
      return (
        <ul className="list-disc space-y-2 pl-5 marker:text-tertiary">
          {block.items.map((item) => (
            <li key={item}>
              <TermsText text={item} />
            </li>
          ))}
        </ul>
      );
    case "paragraph":
      return (
        <p>
          <TermsText text={block.text} />
        </p>
      );
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function TermsText({ text }: { text: string }) {
  return sdpTermsRuns(text).map((run, index) =>
    run.bold ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: runs of one fixed string never reorder.
      <strong key={index} className="font-medium text-primary">
        {run.text}
      </strong>
    ) : (
      run.text
    )
  );
}
