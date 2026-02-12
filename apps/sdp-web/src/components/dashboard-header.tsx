export function DashboardHeader({
  title,
}: {
  title: string;
}) {
  return (
    <header className="border-b border-[rgba(28,28,29,0.08)] pb-6">
      <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px] text-[#1c1c1d]">
        {title}
      </h1>
    </header>
  );
}
