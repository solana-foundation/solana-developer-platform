export default function CreateTokenLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="flex flex-col items-center gap-2">
          <div className="h-9 w-52 animate-pulse rounded-md bg-border-light" />
          <div className="h-5 w-80 animate-pulse rounded-md bg-border-light" />
        </div>

        <div className="space-y-3">
          {["tpl-a", "tpl-b", "tpl-c"].map((id) => (
            <div
              key={id}
              className="flex items-center gap-4 rounded-2xl border border-border-light bg-white px-5 py-4"
            >
              <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-border-light" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-5 w-36 animate-pulse rounded-md bg-border-light" />
                <div className="h-4 w-full max-w-sm animate-pulse rounded-md bg-border-light" />
              </div>
              <div className="h-5 w-5 shrink-0 animate-pulse rounded-md bg-border-light" />
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-3xl">
        <div className="h-14 w-32 animate-pulse rounded-full bg-border-light" />
      </div>
    </div>
  );
}
