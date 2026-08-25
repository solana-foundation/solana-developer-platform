import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsHome } from "@/components/docs-shell/home";
import { HowItWorks, Step, StepPanel } from "@/components/docs-shell/how-it-works";
import {
  MDXBlockquote,
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
    h2: MDXHeading2,
    h3: MDXHeading3,
    h4: MDXHeading4,
    p: MDXParagraph,
    a: MDXLink,
    ul: MDXUnorderedList,
    ol: MDXOrderedList,
    li: MDXListItem,
    blockquote: MDXBlockquote,
    table: MDXTable,
    th: MDXTableHeader,
    td: MDXTableData,
    strong: MDXStrong,
    Tabs,
    Tab,
    DocsHome,
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
