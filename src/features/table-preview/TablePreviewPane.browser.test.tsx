import { describe, expect, it, vi } from "vite-plus/test";
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
  shows: "rows",
  unsaved: false,
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

const definition = {
  definition: 'CREATE TABLE "shop"."people" (\n    "id" bigint NOT NULL\n);',
  indexes: [
    {
      name: "people_by_name",
      definition: "CREATE INDEX people_by_name ON shop.people USING btree (name)",
    },
  ],
  triggers: [],
};

async function preview(
  replies: Partial<Parameters<typeof stubIpc>[0]> = {},
  shows: TableTab["shows"] = "rows",
) {
  const ipc = stubIpc({
    table_shape: shape,
    preview_table: page,
    commit_table_edits: 1,
    table_definition: definition,
    ...replies,
  });
  const onView = vi.fn();
  const screen = await renderApp(
    <TablePreviewPane
      connectionId="c1"
      tab={{ ...tab, shows }}
      hidden={false}
      onView={onView}
      onUnsaved={() => {}}
    />,
  );

  /** A cell is opened for editing by double-clicking it, as in the app. */
  const type = async (cell: string, column: string, value: string) => {
    await screen.getByText(cell, { exact: true }).dblClick();
    const input = screen.getByRole("textbox", { name: column });
    await input.fill(value);
    await userEvent.keyboard("{Enter}");
  };

  const saved = (): TableEdits | null => ipc.sent("commit_table_edits") ?? null;

  return { ipc, screen, type, saved, onView };
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
    expect(ipc.sent("preview_table")).toMatchObject({ versioned: true });
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

  it("reads the rows of a table its driver cannot write, and says why rather than failing", async () => {
    const reason = "A BigQuery table cannot be edited.";
    const { screen } = await preview({
      table_shape: () => {
        throw { kind: "Unsupported", message: reason };
      },
      preview_table: { ...page, versions: [] },
    });

    await expect.element(screen.getByText("Ada")).toBeVisible();
    await expect.element(screen.getByText(reason)).toBeVisible();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });
});

describe("TablePreviewPane showing the structure", () => {
  it("asks for the structure when the switch is used", async () => {
    const { screen, onView } = await preview();

    await screen.getByRole("tab", { name: "Structure" }).click();

    expect(onView).toHaveBeenCalledWith({ shows: "structure" });
  });

  it("shows the statement that would make the table again", async () => {
    const { ipc, screen } = await preview({}, "structure");

    await expect.element(screen.getByText(/CREATE TABLE "shop"\."people"/)).toBeVisible();
    await expect.element(screen.getByText(/CREATE INDEX people_by_name/)).toBeVisible();
    await expect.element(screen.getByText("No trigger.")).toBeVisible();
    expect(ipc.sent("table_definition")).toEqual({
      connection_id: "c1",
      schema: "shop",
      table: "people",
    });
  });

  it("asks the server for nothing but the structure", async () => {
    const { ipc, screen } = await preview({}, "structure");

    await expect.element(screen.getByText(/CREATE TABLE/)).toBeVisible();
    // One connection serves a connection's queries in turn, so a page nobody
    // is looking at would hold up the definition that is on screen.
    expect(ipc.calls.map((call) => call.command)).toEqual(["table_definition"]);
  });

  it("leaves the filter and the row buttons behind with the rows", async () => {
    const { screen } = await preview({}, "structure");

    await expect.element(screen.getByText(/CREATE TABLE/)).toBeVisible();
    expect(screen.getByPlaceholder("WHERE …").elements()).toEqual([]);
    expect(screen.getByRole("button", { name: "New row" }).elements()).toEqual([]);
  });

  it("shows what reading the structure complained about", async () => {
    const { screen } = await preview(
      {
        table_definition: () => {
          throw { kind: "NotFound", message: "shop.people" };
        },
      },
      "structure",
    );

    await expect.element(screen.getByRole("alert")).toBeVisible();
  });
});
