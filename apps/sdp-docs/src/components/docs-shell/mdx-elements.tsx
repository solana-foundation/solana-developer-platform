import defaultMdxComponents from "fumadocs-ui/mdx";
import type React from "react";
import { ExternalDocsLink } from "@/components/docs-shell/external-link";
import { cn } from "@/lib/utils";

export function MDXHeading2({ className, ...props }: React.ComponentPropsWithoutRef<"h2">) {
  const Component = defaultMdxComponents.h2 as React.ComponentType<
    React.ComponentPropsWithoutRef<"h2">
  >;
  return (
    <Component className={cn("launch-mdx-heading launch-mdx-heading-2", className)} {...props} />
  );
}

export function MDXHeading3({ className, ...props }: React.ComponentPropsWithoutRef<"h3">) {
  const Component = defaultMdxComponents.h3 as React.ComponentType<
    React.ComponentPropsWithoutRef<"h3">
  >;
  return (
    <Component className={cn("launch-mdx-heading launch-mdx-heading-3", className)} {...props} />
  );
}

export function MDXHeading4({ className, ...props }: React.ComponentPropsWithoutRef<"h4">) {
  const Component = defaultMdxComponents.h4 as React.ComponentType<
    React.ComponentPropsWithoutRef<"h4">
  >;
  return (
    <Component className={cn("launch-mdx-heading launch-mdx-heading-4", className)} {...props} />
  );
}

export function MDXParagraph({ className, ...props }: React.ComponentPropsWithoutRef<"p">) {
  return <p className={cn("launch-mdx-paragraph", className)} {...props} />;
}

export function MDXLink({
  className,
  href,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  const isExternal = typeof href === "string" && href.startsWith("http");

  if (isExternal) {
    return (
      <ExternalDocsLink href={href} className={className} {...props}>
        {children}
      </ExternalDocsLink>
    );
  }

  return (
    <a href={href} className={cn("launch-mdx-link", className)} {...props}>
      {children}
    </a>
  );
}

export function MDXUnorderedList({ className, ...props }: React.ComponentPropsWithoutRef<"ul">) {
  return <ul className={cn("launch-mdx-list launch-mdx-unordered-list", className)} {...props} />;
}

export function MDXOrderedList({ className, ...props }: React.ComponentPropsWithoutRef<"ol">) {
  return <ol className={cn("launch-mdx-list launch-mdx-ordered-list", className)} {...props} />;
}

export function MDXListItem({ className, ...props }: React.ComponentPropsWithoutRef<"li">) {
  return <li className={cn("launch-mdx-list-item", className)} {...props} />;
}

export function MDXBlockquote({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"blockquote">) {
  return <blockquote className={cn("launch-mdx-blockquote", className)} {...props} />;
}

export function MDXTable({ className, ...props }: React.ComponentPropsWithoutRef<"table">) {
  return <table className={cn("launch-mdx-table", className)} {...props} />;
}

export function MDXTableHeader({ className, ...props }: React.ComponentPropsWithoutRef<"th">) {
  return <th className={cn("launch-mdx-th", className)} {...props} />;
}

export function MDXTableData({ className, ...props }: React.ComponentPropsWithoutRef<"td">) {
  return <td className={cn("launch-mdx-td", className)} {...props} />;
}

export function MDXStrong({ className, ...props }: React.ComponentPropsWithoutRef<"strong">) {
  return <strong className={cn("launch-mdx-strong", className)} {...props} />;
}
