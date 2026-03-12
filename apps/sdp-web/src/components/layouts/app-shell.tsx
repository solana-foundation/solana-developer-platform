import { type ReactNode } from "react";

interface AppShellProps {
  sidebar?: ReactNode;
  children: ReactNode;
}

export function AppShell({ sidebar, children }: AppShellProps) {
  return (
    <div className="flex h-screen bg-[#e9e7de]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow-lg"
      >
        Skip to content
      </a>
      {sidebar}
      <main id="main-content" className="flex-1 p-[var(--layout-shell-gutter)]">
        <div className="flex h-full flex-col overflow-hidden rounded-[var(--layout-shell-frame-radius)] border-[var(--layout-shell-frame-border-width)] border-border-extra-light bg-[rgba(255,255,255,0.8)]">
          {children}
        </div>
      </main>
    </div>
  );
}
