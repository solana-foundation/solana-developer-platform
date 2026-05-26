export function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="text-sm text-text-medium">{label}</span>
      <span className="text-right text-sm font-medium text-text-extra-high">{value}</span>
    </div>
  );
}
