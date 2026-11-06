import defaultMdxComponents from "fumadocs-ui/mdx";
import { ActionLinks } from "@/components/docs-shell/action-links";
import { ApiEndpoint } from "@/components/docs-shell/api-endpoint";
import { ApiFamilyList } from "@/components/docs-shell/api-family-list";
import { ApiOperation, ApiPanel } from "@/components/docs-shell/api-operation";
import { ApiOperationTable } from "@/components/docs-shell/api-operation-table";
import {
  CodeExample,
  DocsCodeBlockTab,
  DocsCodeBlockTabs,
  DocsTab,
  DocsTabs,
} from "@/components/docs-shell/code-example";
import { EarnFlow, GuideCards } from "@/components/docs-shell/guide-layout";
import { DocsHome } from "@/components/docs-shell/home";
import { HowItWorks, Step, StepPanel } from "@/components/docs-shell/how-it-works";
import {
  MDXBlockquote,
  MDXCallout,
  MDXHeading2,
  MDXHeading3,
  MDXHeading4,
  MDXLink,
  MDXListItem,
  MDXOrderedList,
  MDXParagraph,
  MDXStrong,
  MDXTable,
  MDXTableData,
  MDXTableHeader,
  MDXUnorderedList,
} from "@/components/docs-shell/mdx-elements";
import { EnvConfigurator } from "@/components/EnvConfigurator";

type MDXComponents = Record<string, unknown>;

function createMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    pre: CodeExample,
    CodeBlockTabs: DocsCodeBlockTabs,
    CodeBlockTab: DocsCodeBlockTab,
    h2: MDXHeading2,
    h3: MDXHeading3,
    h4: MDXHeading4,
    p: MDXParagraph,
    a: MDXLink,
    ul: MDXUnorderedList,
    ol: MDXOrderedList,
    li: MDXListItem,
    blockquote: MDXBlockquote,
    Callout: MDXCallout,
    table: MDXTable,
    th: MDXTableHeader,
    td: MDXTableData,
    strong: MDXStrong,
    Tabs: DocsTabs,
    Tab: DocsTab,
    ActionLinks,
    ApiEndpoint,
    ApiFamilyList,
    ApiOperation,
    ApiOperationTable,
    ApiPanel,
    DocsHome,
    EarnFlow,
    GuideCards,
    HowItWorks,
    Step,
    StepPanel,
    EnvConfigurator,
    ...components,
  };
}

export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return createMDXComponents(components);
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return createMDXComponents(components);
}
