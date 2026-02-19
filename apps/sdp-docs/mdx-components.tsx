import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMDXComponents(components?: Record<string, any>): Record<string, any> {
  return {
    ...defaultMdxComponents,
    Tabs,
    Tab,
    ...components,
  };
}
