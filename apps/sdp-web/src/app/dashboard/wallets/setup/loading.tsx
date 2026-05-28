export default function WalletSetupLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="flex justify-center">
          <div className="h-9 w-56 animate-pulse rounded-md bg-border-light" />
        </div>

        {["provider-privy", "provider-coinbase", "provider-para", "provider-turnkey"].map((id) => (
          <div
            key={id}
            className="w-full rounded-2xl border border-border-light bg-white px-5 py-5"
          >
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

      <div className="mx-auto flex w-full max-w-3xl justify-between">
        <div className="h-14 w-32 animate-pulse rounded-full bg-border-light" />
        <div className="h-14 w-36 animate-pulse rounded-full bg-border-light" />
      </div>
    </div>
  );
}
