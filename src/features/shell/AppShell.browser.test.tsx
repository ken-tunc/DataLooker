import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { SchemaTree } from "../../bindings/SchemaTree";
import { renderApp, stubIpc } from "../../test/harness";
import { AppShell } from "./AppShell";

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
  command: null,
  created_at: "2026-09-20T00:00:00Z",
};

const staging: ConnectionRecord = { ...local, id: "id-2", label: "Staging" };

const tree: SchemaTree = {
  schemas: [{ name: "shop", tables: [{ name: "people", kind: "table" }] }],
};

const page = {
  result: {
    columns: [{ name: "id", type_name: "INT8" }],
    rows: [[1]],
    truncated: false,
    elapsed_ms: 2,
  },
  versions: ["900"],
};

async function shell(replies: Parameters<typeof stubIpc>[0] = {}) {
  const ipc = stubIpc({
    list_connections: [local, staging],
    running_connection_commands: [],
    language_server_state: { kind: "ready" },
    schema_tree: tree,
    table_columns: [],
    check_syntax: [],
    query_history: [],
    table_shape: { types: { id: "bigint" }, primary_key: ["id"] },
    preview_table: page,
    ...replies,
  });
  // The shell fills the window it is given, and the tabs it holds are drawn at
  // the top of it.
  const screen = await renderApp(
    <div className="h-screen">
      <AppShell />
    </div>,
  );
  // A table tab holds a strip of its own — Rows and Structure — so the tabs
  // this shell keeps are the ones in the strip it draws.
  const strip = '[role="tablist"][aria-label="Open tabs"]';
  const titles = () =>
    [...document.querySelectorAll<HTMLElement>(`${strip} [role="tab"]`)].map((tab) =>
      tab.textContent?.trim(),
    );
  const selected = () =>
    document
      .querySelector<HTMLElement>(`${strip} [role="tab"][aria-selected="true"]`)
      ?.textContent.trim();
  const open = async (label: string) => {
    await screen.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(titles).toEqual(["Query 1"]);
  };
  return { ipc, screen, titles, selected, open };
}

describe("AppShell", () => {
  it("has nothing to query until a connection is chosen", async () => {
    const { screen } = await shell();

    await expect.element(screen.getByText("Select a connection to start querying.")).toBeVisible();
  });

  it("opens a query tab and the connection's tree when one is chosen", async () => {
    const { screen } = await shell();

    await screen.getByRole("button", { name: "Local", exact: true }).click();

    await expect.element(screen.getByRole("tab", { name: /Query 1/ })).toBeVisible();
    await expect.element(screen.getByText("shop")).toBeVisible();
  });

  it("opens another tab on ⌘T", async () => {
    const { titles, selected, open } = await shell();
    await open("Local");

    await userEvent.keyboard("{Meta>}t{/Meta}");

    await expect.poll(titles).toEqual(["Query 1", "Query 2"]);
    expect(selected()).toBe("Query 2");
  });

  it("moves between the tabs on ⌃Tab, and back on ⌃⇧Tab", async () => {
    const { selected, open } = await shell();
    await open("Local");
    await userEvent.keyboard("{Meta>}t{/Meta}");

    await userEvent.keyboard("{Control>}{Tab}{/Control}");
    await expect.poll(selected).toBe("Query 1");

    await userEvent.keyboard("{Control>}{Shift>}{Tab}{/Shift}{/Control}");
    await expect.poll(selected).toBe("Query 2");
  });

  it("opens the table a reader finds through ⌘O", async () => {
    const { screen, titles, open } = await shell();
    await open("Local");

    await userEvent.keyboard("{Meta>}o{/Meta}");
    await screen.getByRole("option", { name: /shop\.people/ }).click();

    await expect.poll(titles).toEqual(["Query 1", "shop.people"]);
  });

  it("opens a statement out of the log behind ⌘Y in a tab of its own", async () => {
    const { screen, titles, open } = await shell({
      query_history: [
        {
          id: 1,
          sql: "SELECT * FROM shop.people",
          ran_at: "2026-09-21T09:30:00.000Z",
          duration_ms: 4,
          row_count: 1,
          error: null,
          source: "reader",
        },
      ],
    });
    await open("Local");

    await userEvent.keyboard("{Meta>}y{/Meta}");
    await screen.getByRole("option", { name: /SELECT \* FROM shop\.people/ }).click();

    await expect.poll(titles).toEqual(["Query 1", "Query 2"]);
  });

  it("keeps the shortcuts quiet while a palette is in front", async () => {
    const { titles, open } = await shell();
    await open("Local");

    await userEvent.keyboard("{Meta>}o{/Meta}");
    await userEvent.keyboard("{Meta>}t{/Meta}");

    // A tab opened behind the palette would go unnoticed.
    expect(titles()).toEqual(["Query 1"]);
  });

  it("gives each connection its own tabs, and finds them again on the way back", async () => {
    const { screen, titles, open } = await shell();
    await open("Local");
    await userEvent.keyboard("{Meta>}t{/Meta}");
    await expect.poll(titles).toEqual(["Query 1", "Query 2"]);

    await screen.getByRole("button", { name: "Staging", exact: true }).click();
    await expect.poll(titles).toEqual(["Query 1"]);

    await screen.getByRole("button", { name: "Local", exact: true }).click();
    await expect.poll(titles).toEqual(["Query 1", "Query 2"]);
  });

  it("has nothing to query again once the connection in front is deleted", async () => {
    const { screen, open } = await shell({
      list_connections: () => [staging],
      delete_connection: null,
    });
    await open("Staging");

    await screen.getByLabelText("Staging actions").click();
    await screen.getByRole("button", { name: "Delete", exact: true }).click();
    await screen.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();

    await expect.element(screen.getByText("Select a connection to start querying.")).toBeVisible();
  });
});
