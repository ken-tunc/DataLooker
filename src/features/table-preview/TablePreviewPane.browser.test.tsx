import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { TableEdits } from "../../bindings/TableEdits";
import { renderApp, stubIpc } from "../../test/harness";
import type { TableTab } from "./hooks";
import { TablePreviewPane } from "./TablePreviewPane";

const tab: TableTab = {
  kind: "table",
  id: "tab-1",
  title: "shop.people",
  schema: "shop",
  table: "people",
  filter: "",
  sort: null,
  page: 0,
};

const shape = {
  types: { id: "bigint", name: "text", note: "text" },
  primary_key: ["id"],
};

const page = {
  result: {
    columns: [
      { name: "id", type_name: "INT8" },
      { name: "name", type_name: "TEXT" },
      { name: "note", type_name: "TEXT" },
    ],
    rows: [
      [1, "Ada", "first"],
      [2, "Grace", null],
    ],
    truncated: false,
    elapsed_ms: 3,
  },
  versions: ["900", "901"],
};

async function preview(replies: Partial<Parameters<typeof stubIpc>[0]> = {}) {
  const ipc = stubIpc({
    table_shape: shape,
    preview_table: page,
    commit_table_edits: 1,
    ...replies,
  });
  const screen = await renderApp(
    <TablePreviewPane connectionId="c1" tab={tab} hidden={false} onView={() => {}} />,
  );

  /** A cell is opened for editing by double-clicking it, as in the app. */
  const type = async (cell: string, column: string, value: string) => {
    await screen.getByText(cell, { exact: true }).dblClick();
    const input = screen.getByRole("textbox", { name: column });
    await input.fill(value);
    await userEvent.keyboard("{Enter}");
  };

  const saved = () => (ipc.sent("commit_table_edits")?.edits as TableEdits | undefined) ?? null;

  return { ipc, screen, type, saved };
}

describe("TablePreviewPane", () => {
  it("shows the rows the table holds", async () => {
    const { screen } = await preview();

    await expect.element(screen.getByText("Ada")).toBeVisible();
    await expect.element(screen.getByText("Grace")).toBeVisible();
    await expect.element(screen.getByText("2 rows on page 1")).toBeVisible();
  });

  it("reads the page once, with the versions an edit needs", async () => {
    const { ipc } = await preview();

    await expect
      .poll(() => ipc.calls.filter((call) => call.command === "preview_table"))
      .toHaveLength(1);
    expect(ipc.sent("preview_table")).toMatchObject({ request: { versioned: true } });
  });

  it("sends only the cell that changed, with the version it was read at", async () => {
    const { screen, type, saved } = await preview();

    await type("Ada", "name", "Katherine");

    await expect.element(screen.getByText("1 unsaved change")).toBeVisible();
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.poll(saved).toEqual({
      connection_id: "c1",
      schema: "shop",
      table: "people",
      inserts: [],
      updates: [{ key: { id: "1" }, set: { name: "Katherine" }, version: "900" }],
      deletes: [],
    });
  });

  it("adds a row with only the columns that were filled in", async () => {
    const { screen, saved } = await preview();

    await screen.getByRole("button", { name: "New row" }).click();
    await expect.element(screen.getByText("1 unsaved change")).toBeVisible();
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.poll(saved).toMatchObject({ inserts: [{ values: {} }] });
  });

  it("keeps a removed row on screen until it is saved", async () => {
    const { screen, saved } = await preview();

    await screen.getByText("Grace").click();
    await screen.getByRole("button", { name: "Remove row" }).click();

    await expect.element(screen.getByText("Grace")).toBeVisible();
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.poll(saved).toMatchObject({
      deletes: [{ key: { id: "2" }, version: "901" }],
    });
  });

  it("discards everything at once", async () => {
    const { ipc, screen, type } = await preview();

    await type("Ada", "name", "Katherine");
    await screen.getByRole("button", { name: "Discard" }).click();

    await expect.element(screen.getByText("Ada")).toBeVisible();
    expect(ipc.sent("commit_table_edits")).toBeUndefined();
  });

  it("tells the reader to reload when the row moved on", async () => {
    const { screen, type } = await preview({
      commit_table_edits: () => {
        throw { kind: "Conflict", message: "a row changed after it was read." };
      },
    });

    await type("Ada", "name", "Katherine");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText(/Reload the page to see what it holds now/))
      .toBeVisible();
  });

  it("is read-only where a row cannot be named", async () => {
    const { screen } = await preview({ table_shape: { types: shape.types, primary_key: [] } });

    await expect
      .element(screen.getByText("Read-only: this relation has no primary key."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "New row" })).not.toBeInTheDocument();
  });
});
