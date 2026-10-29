"use client";

import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "fumadocs-ui/components/ui/popover";
import { ArrowUpRight, ChevronDown, Copy, FileText, MessageCircle } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { CopyStatusAnnouncement, CopyStatusIcon, useCopyStatus } from "./copy-status";

type PageActionsProps = {
  /** The page's Markdown on this origin, the path the `.md` route serves. */
  markdownPath: string;
  /** The same Markdown's public URL, which the ChatGPT and Claude prompts point at. */
  markdownUrl: string;
};

// One request per page however often it is copied; a failure is dropped, so a retry refetches.
const markdownRequests = new Map<string, Promise<string>>();

function fetchMarkdown(path: string): Promise<string> {
  const cached = markdownRequests.get(path);
  if (cached) return cached;
  const request = fetch(path).then((response) => {
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.text();
  });
  markdownRequests.set(path, request);
  request.catch(() => markdownRequests.delete(path));
  return request;
}

/**
 * Copies exactly what the `.md` route serves. The pending fetch goes into the ClipboardItem,
 * so Safari still counts the write as part of the click; where that fails, plain writeText.
 */
async function copyMarkdown(path: string): Promise<void> {
  const markdown = fetchMarkdown(path);
  if (typeof ClipboardItem !== "undefined") {
    try {
      const blob = markdown.then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // A browser without promise-valued items: copy the text once it arrives.
    }
  }
  await navigator.clipboard.writeText(await markdown);
}

/** Up, Down, Home and End move between the menu's items. */
function moveMenuFocus(event: KeyboardEvent<HTMLElement>) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-menu-item]"));
  const index = items.findIndex((item) => item === document.activeElement);
  const next = {
    ArrowDown: items[(index + 1) % items.length],
    ArrowUp: items[(index - 1 + items.length) % items.length],
    Home: items[0],
    End: items[items.length - 1],
  }[event.key];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function MenuItemBody({
  icon,
  title,
  description,
  external,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  external?: boolean;
}) {
  return (
    <>
      <span className="launch-menu-item-icon">{icon}</span>
      <span className="launch-menu-item-text">
        <span className="launch-menu-item-title">{title}</span>
        <span className="launch-menu-item-description">{description}</span>
      </span>
      {external ? <ArrowUpRight className="launch-menu-item-external" aria-hidden="true" /> : null}
    </>
  );
}

/**
 * Copy page for AI, with View as Markdown and Open in ChatGPT or Claude behind the chevron.
 * The label never changes width: "Copied" stacks under "Copy page" in one grid cell.
 */
export function PageActions({ markdownPath, markdownUrl }: PageActionsProps) {
  const copy = useCopyStatus();
  const prompt = `Read ${markdownUrl} so I can ask questions about it.`;
  const chatGptUrl = `https://chatgpt.com/?${new URLSearchParams({ hints: "search", q: prompt })}`;
  const claudeUrl = `https://claude.ai/new?${new URLSearchParams({ q: prompt })}`;
  const copyPage = () => copy.run(() => copyMarkdown(markdownPath));

  return (
    <div className="launch-page-actions">
      <button
        type="button"
        className="launch-page-actions-copy"
        aria-label="Copy page"
        data-status={copy.status}
        onClick={copyPage}
      >
        <CopyStatusIcon status={copy.status} />
        <span className="launch-page-actions-label">
          <span className="is-idle">Copy page</span>
          <span className="is-copied">Copied</span>
        </span>
      </button>
      <Popover>
        <PopoverTrigger className="launch-page-actions-more" aria-label="More page actions">
          <ChevronDown className="launch-chevron" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="launch-popover launch-menu"
          onKeyDown={moveMenuFocus}
        >
          <PopoverClose asChild>
            <button type="button" className="launch-menu-item" data-menu-item onClick={copyPage}>
              <MenuItemBody
                icon={<Copy aria-hidden="true" />}
                title="Copy page"
                description="This page as Markdown, for AI"
              />
            </button>
          </PopoverClose>
          <PopoverClose asChild>
            <a
              href={markdownPath}
              target="_blank"
              rel="noopener"
              className="launch-menu-item"
              data-menu-item
            >
              <MenuItemBody
                icon={<FileText aria-hidden="true" />}
                title="View as Markdown"
                description="Open this page as plain text"
                external
              />
            </a>
          </PopoverClose>
          <PopoverClose asChild>
            <a
              href={chatGptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="launch-menu-item"
              data-menu-item
            >
              <MenuItemBody
                icon={<MessageCircle aria-hidden="true" />}
                title="Open in ChatGPT"
                description="Ask questions about this page"
                external
              />
            </a>
          </PopoverClose>
          <PopoverClose asChild>
            <a
              href={claudeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="launch-menu-item"
              data-menu-item
            >
              <MenuItemBody
                icon={<MessageCircle aria-hidden="true" />}
                title="Open in Claude"
                description="Ask questions about this page"
                external
              />
            </a>
          </PopoverClose>
        </PopoverContent>
      </Popover>
      <CopyStatusAnnouncement
        status={copy.status}
        copied="Page copied as Markdown"
        failed="Couldn't copy the page"
      />
    </div>
  );
}
