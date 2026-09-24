import { describe, expect, it, vi } from "vite-plus/test";
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
  time_zone: null,
  created_at: "2026-09-20T00:00:00Z",
};

const staging: ConnectionRecord = { ...local, id: "id-2", label: "Staging" };

const tree: SchemaTree = {
  schemas: [{ name: "shop", tables: [{ name: "people", kind: "table" }] }],
};

const definition = {
  definition: 'CREATE TABLE "shop"."people" ("id" bigint NOT NULL);',
  indexes: [],
  triggers: [],
};

const page = {
  result: {
    columns: [{ name: "id", type_name: "INT8", instant: false }],
    rows: [[4242]],
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
  // A table tab holds a tablist of its own, and a hidden connection keeps its
  // strip, so only the visible "Open tabs" strip is read.
  const tabs = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="tablist"][aria-label="Open tabs"] [role="tab"]',
      ),
    ].filter((tab) => tab.checkVisibility());
  const titles = () => tabs().map((tab) => tab.textContent?.trim());
  const selected = () =>
    tabs()
      .find((tab) => tab.getAttribute("aria-selected") === "true")
      ?.textContent.trim();
  const open = async (label: string) => {
    await screen.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(titles).toEqual(["Query 1"]);
  };
  return { ipc, screen, titles, selected, open };
}

describe("AppShell", () => {
  it("lets the sidebar and the editor be dragged to another size, and put back", async () => {
    const { screen, open } = await shell();
    await open("Local");
    const sidebar = screen.getByRole("separator", { name: "Resize the sidebar" });
    const editor = screen.getByRole("separator", { name: "Resize the editor" });
    const width = () => document.querySelector("section")?.getBoundingClientRect().width;

    const before = width() as number;
    // Dropped a little way into the pane beside it, which is further right.
    await userEvent.dragAndDrop(sidebar, screen.getByRole("main"), {
      targetPosition: { x: 60, y: 100 },
    });
    await expect.poll(width).toBeGreaterThan(before);

    await sidebar.dblClick();
    await expect.poll(width).toBe(before);

    // The keyboard moves the line as well, once it has focus.
    const height = Number(editor.element().getAttribute("aria-valuenow"));
    await editor.click();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(editor).toHaveAttribute("aria-valuenow", String(height + 16));
    await editor.dblClick();
    await expect.element(editor).toHaveAttribute("aria-valuenow", String(height));
  });

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

  /** Opens shop.people through ⌘O and changes its one cell, without saving. */
  async function editPeople(screen: Awaited<ReturnType<typeof shell>>["screen"]) {
    await userEvent.keyboard("{Meta>}o{/Meta}");
    await screen.getByRole("option", { name: /shop\.people/ }).click();
    await screen.getByText("4242", { exact: true }).dblClick();
    await screen.getByRole("textbox", { name: "id" }).fill("2");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("1 unsaved change")).toBeVisible();
  }

  it("keeps what a connection's tabs hold while another connection is in front", async () => {
    const { screen, open } = await shell();
    await open("Local");
    await editPeople(screen);

    await screen.getByRole("button", { name: "Staging", exact: true }).click();
    await expect.element(screen.getByText("1 unsaved change")).not.toBeVisible();
    await screen.getByRole("button", { name: "Local", exact: true }).click();

    await expect.element(screen.getByText("1 unsaved change")).toBeVisible();
    await expect.element(screen.getByText("2", { exact: true })).toBeVisible();
  });

  /**
   * Opens shop.people showing `shows`, hides it with `hide`, and lets the
   * window come back after everything it read has gone stale. Returns how
   * many reads that sent; showing the tab again has to read each of its
   * queries afresh.
   */
  async function readsWhileHidden(
    shows: "rows" | "structure",
    hide: (screen: Awaited<ReturnType<typeof shell>>["screen"]) => Promise<void>,
  ) {
    const { ipc, screen, open } = await shell({ table_definition: definition });
    await open("Local");
    await userEvent.keyboard("{Meta>}o{/Meta}");
    await screen.getByRole("option", { name: /shop\.people/ }).click();
    if (shows === "structure") {
      await screen.getByRole("tab", { name: "Structure" }).click();
      await expect.element(screen.getByText("No trigger.")).toBeVisible();
    } else {
      await expect.element(screen.getByText("4242", { exact: true })).toBeVisible();
    }
    const commands = ["preview_table", "table_shape", "table_definition"] as const;
    const reads = () =>
      Object.fromEntries(
        commands.map((command) => [
          command,
          ipc.calls.filter((call) => call.command === command).length,
        ]),
      ) as Record<(typeof commands)[number], number>;
    const before = reads();

    await hide(screen);
    // Long enough for the rows, the shape and the definition to have gone stale.
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    try {
      window.dispatchEvent(new Event("visibilitychange"));
      // Whatever the window's return would read, it would have asked for by now.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const hidden = reads();

      await screen.getByRole("button", { name: "Local", exact: true }).click();
      await screen.getByRole("tab", { name: "shop.people" }).click();
      // Every query the view reads is read again, not just one of them.
      const shown =
        shows === "rows"
          ? (["preview_table", "table_shape"] as const)
          : (["table_definition"] as const);
      for (const command of shown) {
        await expect.poll(() => reads()[command]).toBeGreaterThan(hidden[command]);
      }
      return commands.reduce((sum, command) => sum + hidden[command] - before[command], 0);
    } finally {
      later.mockRestore();
    }
  }

  it("leaves a table behind another tab unread when the window comes back", async () => {
    const hidden = await readsWhileHidden("rows", async (screen) => {
      await screen.getByRole("tab", { name: "Query 1" }).click();
    });

    expect(hidden).toBe(0);
  });

  it("leaves a connection's tables unread while another connection is in front", async () => {
    const hidden = await readsWhileHidden("rows", async (screen) => {
      await screen.getByRole("button", { name: "Staging", exact: true }).click();
    });

    expect(hidden).toBe(0);
  });

  it("leaves a table's structure unread while it is out of sight", async () => {
    const hidden = await readsWhileHidden("structure", async (screen) => {
      await screen.getByRole("button", { name: "Staging", exact: true }).click();
    });

    expect(hidden).toBe(0);
  });

  it("asks before closing a tab that holds unsaved changes", async () => {
    const { screen, titles, open } = await shell();
    await open("Local");
    await editPeople(screen);
    const people = screen.getByRole("tab", { name: "shop.people, unsaved changes" });

    await people.click();
    await userEvent.keyboard("{Delete}");
    const asking = screen.getByRole("dialog", { name: "Close shop.people?" });
    await asking.getByRole("button", { name: "Keep editing" }).click();
    expect(titles()).toEqual(["Query 1", "shop.people"]);
    await expect.element(screen.getByText("1 unsaved change")).toBeVisible();
    // Back where the reader was when they asked to close it.
    await expect.element(people).toHaveFocus();

    await people.click();
    await userEvent.keyboard("{Delete}");
    await asking.getByRole("button", { name: "Discard changes" }).click();
    await expect.poll(titles).toEqual(["Query 1"]);
    // The tab that had focus is gone, so the one left in front takes it.
    await expect.element(screen.getByRole("tab", { name: "Query 1" })).toHaveFocus();
  });

  it("closes a table tab with nothing unsaved without asking", async () => {
    const { screen, titles, open } = await shell();
    await open("Local");
    await userEvent.keyboard("{Meta>}o{/Meta}");
    await screen.getByRole("option", { name: /shop\.people/ }).click();

    await screen.getByRole("tab", { name: "shop.people" }).click();
    await userEvent.keyboard("{Delete}");

    await expect.poll(titles).toEqual(["Query 1"]);
    expect(document.querySelector("dialog[open]")).toBeNull();
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
