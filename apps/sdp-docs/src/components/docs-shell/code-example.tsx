"use client";

import {
  CodeBlock,
  type CodeBlockProps,
  CodeBlockTab,
  CodeBlockTabs,
  Pre,
} from "fumadocs-ui/components/codeblock";
import { Tab as FumadocsTab, Tabs as FumadocsTabs } from "fumadocs-ui/components/tabs";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "fumadocs-ui/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "fumadocs-ui/components/ui/tabs";
import { Check, ChevronDown } from "lucide-react";
import {
  Children,
  type ComponentProps,
  createContext,
  isValidElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { readCodeLanguage, storeCodeLanguage } from "@/lib/code-language-storage";
import styles from "./code-example.module.css";
import { CopyStatusAnnouncement, CopyStatusIcon, useCopyStatus } from "./copy-status";

const LANGUAGE_LABELS = {
  bash: "Shell",
  shell: "Shell",
  sh: "Shell",
  terminal: "Shell",
  curl: "cURL",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  py: "Python",
  python: "Python",
  java: "Java",
  rust: "Rust",
  rs: "Rust",
  go: "Go",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  xml: "XML",
  http: "HTTP",
  text: "Text",
  txt: "Text",
  plaintext: "Text",
  md: "Markdown",
  markdown: "Markdown",
  dockerfile: "Dockerfile",
  powershell: "PowerShell",
  swift: "Swift",
  ruby: "Ruby",
  php: "PHP",
  kotlin: "Kotlin",
} as const satisfies Record<string, string>;

function isLanguage(value: string): value is keyof typeof LANGUAGE_LABELS {
  return Object.hasOwn(LANGUAGE_LABELS, value);
}

/** A code language's display name; unfamiliar Shiki languages retain their name. */
function codeLanguageLabel(language: string): string {
  const key = language.toLowerCase();
  return isLanguage(key) ? LANGUAGE_LABELS[key] : language;
}

type CodeOption = { value: string; label: string };
type ChildProps = { value?: string; children?: ReactNode };
const InCodeGroup = createContext<{ singleCode: boolean } | null>(null);
const SINGLE_CODE_GROUP = { singleCode: true };
const MULTIPLE_CODE_GROUP = { singleCode: false };
const languagePreferences = new Map<string, { value?: string; listeners: Set<() => void> }>();

function languageGroup(groupId: string) {
  let group = languagePreferences.get(groupId);
  if (group === undefined) {
    group = { listeners: new Set() };
    languagePreferences.set(groupId, group);
  }
  return group;
}

function subscribeLanguage(groupId: string | undefined, listener: () => void): () => void {
  if (groupId === undefined) return () => {};
  const group = languageGroup(groupId);
  group.listeners.add(listener);
  return () => group.listeners.delete(listener);
}

function languagePreference(
  groupId: string | undefined,
  persist: boolean | undefined
): string | undefined {
  if (groupId === undefined) return undefined;
  const live = languagePreferences.get(groupId)?.value;
  if (live !== undefined) return live;
  return readCodeLanguage(groupId, persist);
}

function saveLanguage(
  groupId: string | undefined,
  value: string,
  persist: boolean | undefined
): void {
  if (groupId === undefined) return;
  const group = languageGroup(groupId);
  storeCodeLanguage(groupId, value, persist);
  group.value = value;
  for (const listener of group.listeners) listener();
}

function singleCodeOf(panel: ReactNode) {
  if (!isValidElement<ChildProps>(panel)) return undefined;
  const body = Children.toArray(panel.props.children).filter(
    (child) => typeof child !== "string" || child.trim() !== ""
  );
  const [only] = body;
  return body.length === 1 &&
    isValidElement<CodeExampleProps>(only) &&
    (only.type === CodeExample ||
      (typeof only.props["data-language"] === "string" &&
        only.props.className?.split(/\s+/).includes("shiki") === true))
    ? only
    : undefined;
}

function singleCodePanels(children: ReactNode): boolean {
  return Children.toArray(children).every(
    (panel) =>
      (typeof panel === "string" && panel.trim() === "") || singleCodeOf(panel) !== undefined
  );
}

/** A generated code tab list carries labels; response status values are not languages. */
function optionsOf(node: ReactNode): CodeOption[] {
  if (!isValidElement<ChildProps>(node)) return [];
  const options: CodeOption[] = [];
  for (const child of Children.toArray(node.props.children)) {
    if (typeof child === "string" && child.trim() === "") continue;
    if (
      !isValidElement<ChildProps>(child) ||
      typeof child.props.value !== "string" ||
      typeof child.props.children !== "string" ||
      !isLanguage(child.props.children.toLowerCase())
    ) {
      return [];
    }
    options.push({ value: child.props.value, label: codeLanguageLabel(child.props.children) });
  }
  return options;
}

/** Copies the active variant, excluding line markers just as Fumadocs' copy control does. */
async function copyCode(container: HTMLElement | null): Promise<void> {
  if (container === null) throw new Error("The code example is not mounted");
  const panel = container.querySelector<HTMLElement>(
    ':scope > [role="tabpanel"][data-state="active"]'
  );
  const pre = (panel === null ? container : panel).querySelector("pre");
  if (pre === null) throw new Error("The code example has no active code");
  const clone = pre.cloneNode(true);
  if (!(clone instanceof HTMLElement)) throw new Error("The code example could not be copied");
  clone.querySelectorAll(".nd-copy-ignore").forEach((node) => {
    node.replaceWith("\n");
  });
  return navigator.clipboard.writeText(clone.textContent ?? "");
}

function CopyCode({ container }: { container: RefObject<HTMLElement | null> }) {
  const copy = useCopyStatus();
  return (
    <>
      <button
        type="button"
        className={styles.copy}
        aria-label="Copy code"
        data-status={copy.status}
        onClick={() => copy.run(() => copyCode(container.current))}
      >
        <CopyStatusIcon status={copy.status} />
        <span className={styles.copyLabel}>
          <span className={styles.idle}>Copy</span>
          <span className={styles.copied}>Copied</span>
        </span>
      </button>
      <CopyStatusAnnouncement
        status={copy.status}
        copied="Code copied"
        failed="Couldn't copy code"
      />
    </>
  );
}

type CodeExampleProps = CodeBlockProps & { "data-language"?: string };

/** Every highlighted fence uses the same language and copy header. */
export function CodeExample({
  title,
  icon: _icon,
  allowCopy,
  className,
  children,
  viewportProps,
  "data-language": language = "text",
  ...props
}: CodeExampleProps) {
  const group = useContext(InCodeGroup);
  const grouped = group?.singleCode === true;
  const container = useRef<HTMLElement>(null);
  const titleIsLanguage = typeof title === "string" && isLanguage(title.toLowerCase());
  const label = titleIsLanguage ? codeLanguageLabel(title) : codeLanguageLabel(language);
  const header = (
    <span className={styles.caption}>
      <span>{label}</span>
      {title && !titleIsLanguage && <span className={styles.filename}>{title}</span>}
    </span>
  );
  return (
    <CodeBlock
      {...props}
      ref={container}
      className={[styles.block, grouped && styles.grouped, className].filter(Boolean).join(" ")}
      data-code-example=""
      data-language={language}
      allowCopy={false}
      title={grouped ? undefined : header}
      Actions={() =>
        !grouped && allowCopy !== false && allowCopy !== "false" ? (
          <CopyCode container={container} />
        ) : null
      }
      viewportProps={{
        ...viewportProps,
        className: [styles.viewport, viewportProps?.className].filter(Boolean).join(" "),
      }}
    >
      <Pre>{children}</Pre>
    </CodeBlock>
  );
}

type LanguageGroupProps = ComponentProps<typeof Tabs> & {
  options: [CodeOption, ...CodeOption[]];
};

/** Dropdown choices remain Fumadocs tabs, preserving keyboard, shared values, and hash selection. */
function LanguageGroup({
  options,
  defaultValue,
  value: controlledValue,
  onValueChange,
  groupId = "docs-code-language",
  persist,
  children,
  className,
  ...props
}: LanguageGroupProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? options[0].value);
  const subscribe = useCallback(
    (listener: () => void) => subscribeLanguage(groupId, listener),
    [groupId]
  );
  const sharedValue = useSyncExternalStore(
    subscribe,
    () => languagePreference(groupId, persist),
    () => undefined
  );
  const offeredSharedValue = options.find(
    (option) => option.label.toLowerCase() === sharedValue
  )?.value;
  const value = controlledValue ?? offeredSharedValue ?? internalValue;
  const selected = options.find((option) => option.value === value);
  if (selected === undefined) throw new Error(`Unknown code language choice: ${value}`);
  const container = useRef<HTMLDivElement>(null);
  const singleCode = singleCodePanels(children);
  const activePanel = Children.toArray(children).find(
    (panel) =>
      isValidElement<ChildProps>(panel) &&
      panel.props.value?.toLowerCase().replace(/\s/, "-") === value.toLowerCase().replace(/\s/, "-")
  );
  const title = singleCode ? singleCodeOf(activePanel)?.props.title : undefined;
  const filename = typeof title === "string" && isLanguage(title.toLowerCase()) ? undefined : title;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <Tabs
      {...props}
      ref={container}
      value={value}
      orientation="vertical"
      onValueChange={(next) => {
        if (controlledValue === undefined) setInternalValue(next);
        const choice = options.find((option) => option.value === next);
        if (choice === undefined) throw new Error(`Unknown code language choice: ${next}`);
        saveLanguage(groupId, choice.label.toLowerCase(), persist);
        onValueChange?.(next);
      }}
      className={[styles.group, className].filter(Boolean).join(" ")}
      data-code-example=""
    >
      <div className={styles.header}>
        <span className={styles.caption}>
          {options.length === 1 ? (
            <span className={styles.languageLabel}>{selected.label}</span>
          ) : (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger
                className={styles.language}
                aria-label={`Code language: ${selected.label}`}
              >
                {selected.label}
                <ChevronDown aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent align="start" className={`launch-popover ${styles.menu}`}>
                <TabsList aria-label="Code language" className={styles.choices}>
                  {options.map((option) => (
                    <PopoverClose key={option.value} asChild>
                      <TabsTrigger
                        value={option.value}
                        className={styles.choice}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") setMenuOpen(false);
                        }}
                      >
                        {option.label}
                        {option.value === value && <Check aria-hidden="true" />}
                      </TabsTrigger>
                    </PopoverClose>
                  ))}
                </TabsList>
              </PopoverContent>
            </Popover>
          )}
          {filename && <span className={styles.filename}>{filename}</span>}
        </span>
        {singleCode && <CopyCode container={container} />}
      </div>
      <InCodeGroup value={singleCode ? SINGLE_CODE_GROUP : MULTIPLE_CODE_GROUP}>
        {children}
      </InCodeGroup>
    </Tabs>
  );
}

/** Generated request language tabs become dropdowns; response status tabs keep their labels. */
export function DocsCodeBlockTabs({
  children,
  className,
  ...props
}: ComponentProps<typeof CodeBlockTabs>) {
  const nodes = Children.toArray(children);
  for (const node of nodes) {
    const [first, ...rest] = optionsOf(node);
    if (first === undefined) continue;
    return (
      <LanguageGroup {...props} className={className} options={[first, ...rest]}>
        {nodes.filter((child) => child !== node)}
      </LanguageGroup>
    );
  }
  return (
    <CodeBlockTabs {...props} className={[styles.status, className].filter(Boolean).join(" ")}>
      {children}
    </CodeBlockTabs>
  );
}

/** Hidden code variants stay mounted so search and fragment links can reveal them. */
export function DocsCodeBlockTab({ className, ...props }: ComponentProps<typeof CodeBlockTab>) {
  const group = useContext(InCodeGroup);
  const panelProps: ComponentProps<typeof CodeBlockTab> = {
    ...props,
    forceMount: true,
    className: [styles.panel, className].filter(Boolean).join(" "),
  };
  if (group !== null) {
    panelProps["aria-label"] =
      props["aria-label"] ?? `${codeLanguageLabel(props.value)} code example`;
    panelProps["aria-labelledby"] = undefined;
  }
  return <CodeBlockTab {...panelProps} />;
}

/** Authored language alternatives share the shell; workflow and UI/API tabs stay regular. */
export function DocsTabs(props: ComponentProps<typeof FumadocsTabs>) {
  return <DocsTabsRoot {...props} />;
}

function DocsTabsRoot({
  items,
  defaultIndex = 0,
  defaultValue,
  children,
  ...props
}: ComponentProps<typeof FumadocsTabs>) {
  if (!items || items.length === 0 || !items.every((item) => isLanguage(item.toLowerCase()))) {
    return (
      <FumadocsTabs
        {...props}
        items={items}
        defaultIndex={defaultIndex}
        defaultValue={defaultValue}
      >
        {children}
      </FumadocsTabs>
    );
  }
  const [first, ...rest] = items.map((item) => ({
    value: item.toLowerCase().replace(/\s/, "-"),
    label: codeLanguageLabel(item),
  }));
  if (first === undefined) throw new Error("A code language group needs a choice");
  const initial = items[defaultIndex];
  if (initial === undefined) throw new Error("The default code language is outside its choices");
  return (
    <LanguageGroup
      {...props}
      defaultValue={defaultValue ?? initial.toLowerCase().replace(/\s/, "-")}
      options={[first, ...rest]}
    >
      {children}
    </LanguageGroup>
  );
}

/** Authored code panels use the shared tab root while ordinary panels keep Fumadocs behavior. */
export function DocsTab({ value, ...props }: ComponentProps<typeof FumadocsTab>) {
  const group = useContext(InCodeGroup);
  if (group === null) return <FumadocsTab {...props} value={value} forceMount />;
  if (value === undefined) throw new Error("A code language tab needs an explicit value");
  return (
    <TabsContent
      {...props}
      value={value.toLowerCase().replace(/\s/, "-")}
      aria-label={props["aria-label"] ?? `${codeLanguageLabel(value)} code example`}
      aria-labelledby={undefined}
      forceMount
      className={styles.panel}
    />
  );
}
