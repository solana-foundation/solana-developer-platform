export function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-xs font-medium uppercase tracking-[0.4px] text-muted">
        {label}
      </span>
      <div className="flex-1 border-t border-border-subtle" />
    </div>
  );
}
