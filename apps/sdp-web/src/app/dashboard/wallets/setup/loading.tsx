export default function WalletSetupLoading() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 py-12">
      {["api-wallet", "institutional-wallet"].map((id) => (
        <div key={id} className="w-full rounded-2xl border border-border-light bg-white px-5 py-5">
          <div className="flex items-start gap-4">
            <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-border-light" />
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
              <div className="h-6 w-48 animate-pulse rounded-md bg-border-light" />
              <div className="h-4 w-full max-w-[42rem] animate-pulse rounded-md bg-border-light" />
            </div>
            <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-border-light" />
          </div>
        </div>
      ))}
    </div>
  );
}
