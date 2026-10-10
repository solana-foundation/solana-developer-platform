// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { loadFireblocksVaultsAction } from "./fireblocks-csr-actions";
import { FireblocksVaultPicker } from "./fireblocks-vault-picker";

vi.mock("./fireblocks-csr-actions", () => ({ loadFireblocksVaultsAction: vi.fn() }));
const ready = vi.fn();
function renderPicker(multiple = true) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <form aria-label="Vault selection">
        <FireblocksVaultPicker
          signingKeyId="fbcsr_test"
          multiple={multiple}
          onReadyChange={ready}
        />
      </form>
    </I18nProvider>
  );
}
beforeEach(() => {
  vi.mocked(loadFireblocksVaultsAction).mockReset();
  ready.mockReset();
});
afterEach(cleanup);

it("keeps selections across pages and invalidates them when the API user changes", async () => {
  vi.mocked(loadFireblocksVaultsAction)
    .mockResolvedValueOnce({
      status: "success",
      vaults: [{ id: "0", name: "Treasury", hasSolanaWallet: true }],
      nextCursor: "page2",
    })
    .mockResolvedValueOnce({
      status: "success",
      vaults: [{ id: "7", name: "Operations", hasSolanaWallet: true }],
      nextCursor: null,
    });
  const user = userEvent.setup();
  renderPicker();
  await user.type(screen.getByLabelText("API user ID"), "api-user");
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  await user.click(await screen.findByRole("checkbox", { name: /Treasury/ }));
  await user.click(screen.getByRole("button", { name: "Load more vaults" }));
  await user.click(await screen.findByRole("checkbox", { name: /Operations/ }));
  const form = screen.getByRole("form") as HTMLFormElement;
  expect(new FormData(form).getAll("fireblocksVaultAccountIds")).toEqual(["0", "7"]);
  expect(loadFireblocksVaultsAction).toHaveBeenLastCalledWith({
    signingKeyId: "fbcsr_test",
    apiKey: "api-user",
    after: "page2",
  });
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  await user.type(screen.getByLabelText("API user ID"), "-changed");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(new FormData(form).get("vaultAccountId")).toBe("");
  expect(new FormData(form).getAll("fireblocksVaultAccountIds")).toEqual([]);
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(false));
});

it("shows empty and failed discovery without allowing a connection", async () => {
  vi.mocked(loadFireblocksVaultsAction)
    .mockResolvedValueOnce({ status: "error", message: "Registration is not approved" })
    .mockResolvedValueOnce({ status: "success", vaults: [], nextCursor: null });
  const user = userEvent.setup();
  renderPicker();
  await user.type(screen.getByLabelText("API user ID"), "api-user");
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Registration is not approved"
  );
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  await screen.findByText(/No Solana vaults found/);
  expect(ready).toHaveBeenLastCalledWith(false);
});

it("limits credential rotation to one original vault", async () => {
  vi.mocked(loadFireblocksVaultsAction).mockResolvedValue({
    status: "success",
    vaults: [
      { id: "0", name: "Treasury", hasSolanaWallet: true },
      { id: "7", name: "Operations", hasSolanaWallet: true },
    ],
    nextCursor: null,
  });
  const user = userEvent.setup();
  renderPicker(false);
  await user.type(screen.getByLabelText("API user ID"), "api-user");
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  await user.click(await screen.findByRole("radio", { name: /Treasury/ }));
  await user.click(screen.getByRole("radio", { name: /Operations/ }));
  const form = screen.getByRole("form") as HTMLFormElement;
  expect(new FormData(form).get("vaultAccountId")).toBe("7");
  expect(new FormData(form).getAll("fireblocksVaultAccountIds")).toEqual([]);
});

it("clears old selections and lets users retry after a network failure", async () => {
  const page = {
    status: "success" as const,
    vaults: [{ id: "0", name: "Treasury", hasSolanaWallet: true }],
    nextCursor: null,
  };
  vi.mocked(loadFireblocksVaultsAction)
    .mockResolvedValueOnce(page)
    .mockRejectedValueOnce(new Error("Network disconnected"))
    .mockResolvedValueOnce(page);
  const user = userEvent.setup();
  renderPicker();
  await user.type(screen.getByLabelText("API user ID"), "api-user");
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  await user.click(await screen.findByRole("checkbox", { name: /Treasury/ }));
  expect(ready).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not load vaults. Check your connection and try again."
  );
  expect(new FormData(screen.getByRole("form") as HTMLFormElement).get("vaultAccountId")).toBe("");
  expect(ready).toHaveBeenLastCalledWith(false);
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  await user.click(await screen.findByRole("checkbox", { name: /Treasury/ }));
  expect(ready).toHaveBeenLastCalledWith(true);
});
