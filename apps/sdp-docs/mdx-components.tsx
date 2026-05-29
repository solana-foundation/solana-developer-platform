import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type React from "react";
import { DocsHome } from "@/components/docs-shell/home";
import { HowItWorks, Step, StepPanel } from "@/components/docs-shell/how-it-works";
import { cn } from "@/lib/utils";

type MDXComponents = Record<string, unknown>;

function MDXHeading2({ className, ...props }: React.ComponentPropsWithoutRef<"h2">) {
  const Component = defaultMdxComponents.h2 as React.ComponentType<
    React.ComponentPropsWithoutRef<"h2">
  >;
  return (
    <Component className={cn("launch-mdx-heading launch-mdx-heading-2", className)} {...props} />
  );
}

function MDXHeading3({ className, ...props }: React.ComponentPropsWithoutRef<"h3">) {
  const Component = defaultMdxComponents.h3 as React.ComponentType<
    React.ComponentPropsWithoutRef<"h3">
  >;
  return (
    <Component className={cn("launch-mdx-heading launch-mdx-heading-3", className)} {...props} />
  );
}

function MDXHeading4({ className, ...props }: React.ComponentPropsWithoutRef<"h4">) {
  const Component = defaultMdxComponents.h4 as React.ComponentType<
    React.ComponentPropsWithoutRef<"h4">
  >;
  return (
    <Component className={cn("launch-mdx-heading launch-mdx-heading-4", className)} {...props} />
  );
}

function MDXParagraph({ className, ...props }: React.ComponentPropsWithoutRef<"p">) {
  return <p className={cn("launch-mdx-paragraph", className)} {...props} />;
}

function MDXLink({ className, ...props }: React.ComponentPropsWithoutRef<"a">) {
  return <a className={cn("launch-mdx-link", className)} {...props} />;
}

function MDXUnorderedList({ className, ...props }: React.ComponentPropsWithoutRef<"ul">) {
  return <ul className={cn("launch-mdx-list launch-mdx-unordered-list", className)} {...props} />;
}

function MDXOrderedList({ className, ...props }: React.ComponentPropsWithoutRef<"ol">) {
  return <ol className={cn("launch-mdx-list launch-mdx-ordered-list", className)} {...props} />;
}

function MDXListItem({ className, ...props }: React.ComponentPropsWithoutRef<"li">) {
  return <li className={cn("launch-mdx-list-item", className)} {...props} />;
}

function MDXBlockquote({ className, ...props }: React.ComponentPropsWithoutRef<"blockquote">) {
  return <blockquote className={cn("launch-mdx-blockquote", className)} {...props} />;
}

function MDXTable({ className, ...props }: React.ComponentPropsWithoutRef<"table">) {
  return <table className={cn("launch-mdx-table", className)} {...props} />;
}

function MDXTableHeader({ className, ...props }: React.ComponentPropsWithoutRef<"th">) {
  return <th className={cn("launch-mdx-th", className)} {...props} />;
}

function MDXTableData({ className, ...props }: React.ComponentPropsWithoutRef<"td">) {
  return <td className={cn("launch-mdx-td", className)} {...props} />;
}

function MDXStrong({ className, ...props }: React.ComponentPropsWithoutRef<"strong">) {
  return <strong className={cn("launch-mdx-strong", className)} {...props} />;
}

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
    ...components,
  };
}

export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return createMDXComponents(components);
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return createMDXComponents(components);
}
