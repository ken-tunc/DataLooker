import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { SchemaTree } from "../../bindings/SchemaTree";
import { renderApp, stubIpc } from "../../test/harness";
import { TableSearchPalette } from "./TableSearchPalette";

const table = (name: string) => ({ name, kind: "table" as const, columns: [] });

const tree: SchemaTree = {
  schemas: [
    { name: "public", tables: [table("people"), table("orders"), table("order_items")] },
    { name: "analytics", tables: [{ ...table("people_daily"), kind: "view" as const }] },
  ],
};

async function palette(replies: Record<string, unknown> = { schema_tree: tree }) {
  stubIpc(replies);
  const onOpenTable = vi.fn();
  const onClose = vi.fn();
  const screen = await renderApp(
    <TableSearchPalette connectionId="c1" onOpenTable={onOpenTable} onClose={onClose} />,
  );
  const find = screen.getByRole("combobox", { name: "Find a table" });
  return { screen, find, onOpenTable, onClose };
}

describe("TableSearchPalette", () => {
  it("offers every table before anything is typed", async () => {
    const { screen } = await palette();

    await expect.element(screen.getByRole("option", { name: /public\.people/ })).toBeVisible();
    await expect.poll(() => screen.getByRole("option").elements()).toHaveLength(4);
  });

  it("narrows to what the letters name, wherever they sit in it", async () => {
    const { screen, find } = await palette();

    await find.fill("odit");

    await expect.poll(() => screen.getByRole("option").elements()).toHaveLength(1);
    await expect.element(screen.getByRole("option", { name: /order_items/ })).toBeVisible();
  });

  it("opens the table under the arrow keys when Enter is pressed", async () => {
    const { find, onOpenTable, onClose } = await palette();

    await find.fill("people");
    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(onOpenTable).toHaveBeenCalledWith("analytics", "people_daily");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("moves down the list on ⌃N", async () => {
    const { find, onOpenTable } = await palette();

    await find.fill("people");
    await userEvent.keyboard("{Control>}n{/Control}{Enter}");

    expect(onOpenTable).toHaveBeenCalledWith("analytics", "people_daily");
  });

  it("moves back up on ⌃P", async () => {
    const { find, onOpenTable } = await palette();

    await find.fill("people");
    await userEvent.keyboard("{Control>}n{/Control}{Control>}p{/Control}{Enter}");

    expect(onOpenTable).toHaveBeenCalledWith("public", "people");
  });

  it("opens the table a click lands on", async () => {
    const { screen, onOpenTable } = await palette();

    await screen.getByRole("option", { name: /public\.orders/ }).click();

    expect(onOpenTable).toHaveBeenCalledWith("public", "orders");
  });

  it("says so rather than showing a stale list", async () => {
    const { screen, find } = await palette();

    await find.fill("zzz");

    await expect.element(screen.getByText("No table matches.")).toBeVisible();
  });

  it("shows the schema's own complaint", async () => {
    const { screen } = await palette({
      schema_tree: () => {
        throw { kind: "Database", message: "permission denied for schema public" };
      },
    });

    await expect.element(screen.getByText("permission denied for schema public")).toBeVisible();
  });
});
