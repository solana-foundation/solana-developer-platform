export function DashboardHeader({
  title,
}: {
  title: string;
}) {
  return (
    <header className="pb-4">
      <h1 className="text-[38px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">
        {title}
      </h1>
    </header>
  );
}
