import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SchemaTree as Tree } from "../../bindings/SchemaTree";
import { renderApp, stubIpc } from "../../test/harness";
import { treeRows } from "./rows";
import { SchemaTree } from "./SchemaTree";

// Watched, to tell when the tree is laid out again: that walks every table of
// every schema, and a project can hold tens of thousands.
vi.mock("./rows", async (original) => {
  const rows = await original<typeof import("./rows")>();
  return { ...rows, treeRows: vi.fn(rows.treeRows) };
});

const tree: Tree = {
  schemas: [
    {
      name: "shop",
      tables: [
        { name: "orders", kind: "table" },
        { name: "recent_orders", kind: "view" },
      ],
    },
    { name: "analytics", tables: [{ name: "daily", kind: "table" }] },
    {
      name: "logs",
      tables: [
        { name: "events_20250101", kind: "table" },
        { name: "events_20250102", kind: "table" },
        { name: "events_20250103", kind: "table" },
      ],
    },
  ],
};

const columns = [
  { name: "id", data_type: "bigint", nullable: false },
  { name: "total", data_type: "numeric", nullable: true },
];

async function schemaTree(replies: Parameters<typeof stubIpc>[0] = {}) {
  const ipc = stubIpc({ schema_tree: tree, table_columns: columns, ...replies });
  const onOpenTable = vi.fn();
  const screen = await renderApp(
    <div className="h-96">
      <SchemaTree connectionId="c1" onOpenTable={onOpenTable} />
    </div>,
  );
  return { ipc, screen, onOpenTable };
}

describe("SchemaTree", () => {
  it("shows the schemas, and their tables once one is opened", async () => {
    const { ipc, screen } = await schemaTree();

    await expect.element(screen.getByText("shop")).toBeVisible();
    expect(screen.getByText("orders", { exact: true }).elements()).toEqual([]);

    await screen.getByText("shop").click();

    await expect.element(screen.getByText("orders", { exact: true })).toBeVisible();
    // Nothing was asked about what a table holds: nobody has opened one.
    expect(ipc.calls.map((call) => call.command)).not.toContain("table_columns");
  });

  it("asks what a table holds when the table is opened, and once only", async () => {
    const { ipc, screen } = await schemaTree();
    await screen.getByText("shop").click();

    await screen.getByLabelText("Expand orders").click();

    await expect.element(screen.getByText("total")).toBeVisible();
    await expect.element(screen.getByText("numeric")).toBeVisible();
    expect(ipc.sent("table_columns")).toEqual({
      connection_id: "c1",
      schema: "shop",
      table: "orders",
    });

    // Closed and opened again, the answer is the one already in hand.
    await screen.getByLabelText("Collapse orders").click();
    await screen.getByLabelText("Expand orders").click();
    await expect.element(screen.getByText("total")).toBeVisible();
    expect(ipc.calls.filter((call) => call.command === "table_columns")).toHaveLength(1);
  });

  it("reads an open table's columns again when the schema is reloaded", async () => {
    const { ipc, screen } = await schemaTree();
    await screen.getByText("shop").click();
    await screen.getByLabelText("Expand orders").click();
    await expect.element(screen.getByText("total")).toBeVisible();

    // A schema that changed changes what its tables hold, so reading it again
    // is reading those again too.
    await screen.getByLabelText("Reload the schema").click();

    await expect
      .poll(() => ipc.calls.filter((call) => call.command === "table_columns"))
      .toHaveLength(2);
  });

  it("says what went wrong where the columns would have been", async () => {
    const { screen } = await schemaTree({
      table_columns: () => {
        throw { kind: "Database", message: "the dataset is gone" };
      },
    });
    await screen.getByText("shop").click();

    await screen.getByLabelText("Expand orders").click();

    await expect.element(screen.getByText("the dataset is gone")).toBeVisible();
  });

  it("shows a set of shards as one row, holding the days it was written on", async () => {
    const { onOpenTable, screen } = await schemaTree();
    await screen.getByText("logs").click();

    await expect.element(screen.getByText("events_*")).toBeVisible();
    await expect.element(screen.getByText("3 shards")).toBeVisible();
    expect(screen.getByText("events_20250103").elements()).toEqual([]);

    await screen.getByText("events_*").click();
    await screen.getByText("events_20250103").click();

    expect(onOpenTable).toHaveBeenCalledWith("logs", "events_20250103");
  });

  it("is not laid out again when the window re-renders it", async () => {
    stubIpc({ schema_tree: tree, table_columns: columns });
    // As the window does on every keystroke in the editor: a new handler each time.
    function Typing() {
      const [typed, setTyped] = useState("");
      return (
        <div className="h-96">
          <button type="button" onClick={() => setTyped(`${typed}x`)}>
            Type
          </button>
          <SchemaTree connectionId="c1" onOpenTable={() => typed} />
        </div>
      );
    }
    const screen = await renderApp(<Typing />);
    await screen.getByText("shop").click();
    await screen.getByLabelText("Expand orders").click();
    await expect.element(screen.getByText("total")).toBeVisible();

    const laidOut = vi.mocked(treeRows).mock.calls.length;
    await screen.getByText("Type").click();
    await screen.getByText("Type").click();
    expect(vi.mocked(treeRows).mock.calls.length).toBe(laidOut);
  });

  it("opens the table a reader clicks, rather than its columns", async () => {
    const { onOpenTable, screen } = await schemaTree();
    await screen.getByText("shop").click();

    await screen.getByText("orders", { exact: true }).click();

    expect(onOpenTable).toHaveBeenCalledWith("shop", "orders");
  });
});
