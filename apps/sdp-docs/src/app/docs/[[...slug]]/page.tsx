import { source } from "@/lib/source";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { ComponentType } from "react";

const mdxComponents = {
  ...defaultMdxComponents,
  Tabs,
  Tab,
};

type DocsData = {
  title: string;
  description?: string;
  body?: ComponentType<{ components?: Record<string, unknown> }>;
  content?: ComponentType<{ components?: Record<string, unknown> }>;
  toc?: Parameters<typeof DocsPage>[0]["toc"];
  full?: Parameters<typeof DocsPage>[0]["full"];
};

type DocsPageProps = {
  params: Promise<{ slug?: string[] }>;
};

export default async function Page({ params }: DocsPageProps) {
  const { slug } = await params;

  if (!slug || slug.length === 0) {
    redirect("/docs/what-is-solana-developer-platform");
  }

  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const data = page.data as DocsData;
  const MDX = data.body ?? data.content;

  if (!MDX) {
    notFound();
  }

  return (
    <DocsPage toc={data.toc} full={data.full}>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
        <MDX components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    return {};
  }

  const data = page.data as DocsData;

  return {
    title: data.title,
    description: data.description,
  };
}
