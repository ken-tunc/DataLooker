import { describe, expect, it } from "vite-plus/test";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { renderApp, stubIpc } from "../../test/harness";
import { ConnectionSidebar } from "./ConnectionSidebar";

const local: ConnectionRecord = {
  id: "id-1",
  label: "Local",
  config: {
    kind: "postgres",
    host: "localhost",
    port: 5432,
    database: "datalooker",
    username: "admin",
  },
  created_at: "2026-09-20T00:00:00Z",
};

async function sidebar(replies: Parameters<typeof stubIpc>[0]) {
  const ipc = stubIpc(replies);
  const screen = await renderApp(
    <ConnectionSidebar selectedId={null} onSelect={() => {}} onRemoved={() => {}} />,
  );

  /**
   * The row's actions live behind its ⋯ menu, which starts closed. The menu
   * opens a `<summary>`, which is a disclosure rather than a button, so it is
   * found by its label.
   */
  const actions = async (label: string, action: string) => {
    await screen.getByLabelText(`${label} actions`).click();
    await screen.getByRole("button", { name: action, exact: true }).click();
  };

  return { ipc, screen, actions };
}

describe("ConnectionSidebar", () => {
  it("lists what the backend holds", async () => {
    const { screen } = await sidebar({
      list_connections: [local, { ...local, id: "id-2", label: "Staging" }],
    });

    await expect.element(screen.getByText("Local", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Staging", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("localhost:5432/datalooker").first()).toBeVisible();
  });

  it("says so when there is nothing to connect to", async () => {
    const { screen } = await sidebar({ list_connections: [] });

    await expect.element(screen.getByText("No connections yet.")).toBeVisible();
  });

  it("shows the database's own complaint, and can ask again", async () => {
    let attempts = 0;
    const { screen } = await sidebar({
      list_connections: () => {
        attempts += 1;
        if (attempts === 1) throw { kind: "Database", message: "meta.db is locked" };
        return [local];
      },
    });

    await expect.element(screen.getByText("meta.db is locked")).toBeVisible();
    await screen.getByRole("button", { name: "Retry" }).click();

    await expect.element(screen.getByText("Local", { exact: true })).toBeVisible();
  });

  it("reports how long a test took, in a toast", async () => {
    const { screen, actions } = await sidebar({ list_connections: [local], test_connection: 12 });

    await actions("Local", "Test");

    await expect.element(screen.getByText("Reached Local in 12 ms")).toBeVisible();
  });

  it("names the failure a test hit, rather than a message of its own", async () => {
    const { screen, actions } = await sidebar({
      list_connections: [local],
      test_connection: () => {
        throw { kind: "Database", message: "password authentication failed" };
      },
    });

    await actions("Local", "Test");

    await expect.element(screen.getByText("password authentication failed")).toBeVisible();
  });

  it("asks before deleting, and sends the id when told to", async () => {
    const { ipc, screen, actions } = await sidebar({
      list_connections: [local],
      delete_connection: null,
    });

    await actions("Local", "Delete");
    await expect.element(screen.getByText("Delete Local?")).toBeVisible();
    expect(ipc.sent("delete_connection")).toBeUndefined();

    // The row's menu holds a Delete of its own, so this one is the dialog's.
    await screen.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();

    await expect.element(screen.getByText("Deleted Local")).toBeVisible();
    expect(ipc.sent("delete_connection")).toEqual({ id: "id-1" });
  });
});
