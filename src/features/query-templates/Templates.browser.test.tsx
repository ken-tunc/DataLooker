import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { QueryTemplate } from "../../bindings/QueryTemplate";
import { type Replies, renderApp, stubIpc } from "../../test/harness";
import { AppShell } from "../shell/AppShell";
import { editor as monaco } from "../sql-editor/monaco";

const local: ConnectionRecord = {
  id: "c1",
  label: "Local",
  config: {
    kind: "postgres",
    host: "localhost",
    port: 5432,
    database: "datalooker",
    username: "admin",
  },
  command: null,
  command_while_selected: false,
  time_zone: null,
  production: false,
  created_at: "2026-09-20T00:00:00Z",
};

const ordersOf: QueryTemplate = {
  id: "t1",
  name: "Orders of a customer",
  sql: "SELECT * FROM orders WHERE customer_id = @id AND note = @note -- @id",
};

const everything: QueryTemplate = { id: "t2", name: "Every order", sql: "SELECT * FROM orders" };

async function shell(replies: Replies = {}) {
  const ipc = stubIpc({
    list_connections: [local],
    running_connection_commands: [],
    language_server_state: { kind: "ready" },
    schema_tree: { schemas: [] },
    check_syntax: [],
    list_templates: [ordersOf, everything],
    ...replies,
  });
  const screen = await renderApp(
    <div className="h-screen">
      <AppShell />
    </div>,
  );
  const titles = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="tablist"][aria-label="Open tabs"] [role="tab"]',
      ),
    ]
      .filter((tab) => tab.checkVisibility())
      .map((tab) => tab.textContent?.trim());
  const statements = () => monaco.getEditors().map((open) => open.getValue());

  await screen.getByRole("button", { name: "Local", exact: true }).click();
  await expect.poll(titles).toEqual(["Query 1"]);
  return { ipc, screen, titles, statements };
}

describe("query templates", () => {
  it("asks for each blank and opens what they make in a tab named after the template", async () => {
    const { screen, titles, statements } = await shell();

    await userEvent.keyboard("{Meta>}j{/Meta}");
    await screen.getByRole("option", { name: /Orders of a customer/ }).click();

    const dialog = screen.getByRole("dialog", { name: "Orders of a customer" });
    await dialog.getByRole("combobox", { name: "Type of @id" }).selectOptions("Number");
    await dialog.getByRole("textbox", { name: "@id" }).fill("42");
    await dialog.getByRole("textbox", { name: "@note" }).fill("it's");
    await dialog.getByRole("button", { name: "Open in a new tab" }).click();

    await expect.poll(titles).toEqual(["Query 1", "Orders of a customer"]);
    await expect
      .poll(statements)
      .toContain("SELECT * FROM orders WHERE customer_id = 42 AND note = 'it''s' -- @id");
  });

  it("keeps the dialog open over a value that cannot be written in", async () => {
    const { screen, titles } = await shell();

    await userEvent.keyboard("{Meta>}j{/Meta}");
    await screen.getByRole("option", { name: /Orders of a customer/ }).click();
    const dialog = screen.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Type of @id" }).selectOptions("Number");
    await dialog.getByRole("textbox", { name: "@id" }).fill("forty-two");
    await dialog.getByRole("button", { name: "Open in a new tab" }).click();

    await expect.element(dialog.getByText("Not a number")).toBeVisible();
    expect(titles()).toEqual(["Query 1"]);
  });

  it("opens a template with no blanks as it is", async () => {
    const { screen, titles, statements } = await shell();

    await userEvent.keyboard("{Meta>}j{/Meta}");
    await screen.getByRole("option", { name: /Every order/ }).click();

    await expect.poll(titles).toEqual(["Query 1", "Every order"]);
    await expect.poll(statements).toContain("SELECT * FROM orders");
  });

  it("saves the tab's statement under the name given", async () => {
    const { ipc, screen } = await shell({ save_template: "t3" });
    await expect.poll(() => monaco.getEditors().length).toBe(1);
    monaco.getEditors()[0]?.setValue("SELECT @n");

    await screen.getByRole("button", { name: "Save as template" }).click();
    const dialog = screen.getByRole("dialog");
    await dialog.getByLabelText("Name").fill("Numbered");
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByText("Saved Numbered")).toBeVisible();
    expect(ipc.sent("save_template")).toEqual({ id: null, name: "Numbered", sql: "SELECT @n" });
  });

  it("says in the form when the name is taken", async () => {
    const { screen } = await shell({
      save_template: () => {
        throw { kind: "Conflict", message: "a template is already called Every order" };
      },
    });

    await userEvent.keyboard("{Meta>}j{/Meta}");
    await screen.getByRole("button", { name: "Manage templates…" }).click();
    await screen.getByRole("button", { name: "Edit" }).first().click();
    const form = screen.getByRole("group", { name: "Edit template" });
    await form.getByLabelText("Name").fill("Every order");
    await screen.getByRole("button", { name: "Save", exact: true }).click();

    const name = form.getByLabelText("Name");
    await expect
      .element(name)
      .toHaveAccessibleDescription("a template is already called Every order");
    await expect.element(name).toHaveAttribute("aria-invalid", "true");

    // Gone once the reader changes what it was about.
    await name.fill("Every order again");
    await expect.element(form.getByRole("alert")).not.toBeInTheDocument();
  });

  it("goes back to the list when the form over it is closed", async () => {
    const { screen } = await shell();

    await userEvent.keyboard("{Meta>}j{/Meta}");
    await screen.getByRole("button", { name: "Manage templates…" }).click();
    await screen.getByRole("button", { name: "Edit" }).first().click();
    await expect.element(screen.getByRole("group", { name: "Edit template" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await expect
      .element(screen.getByRole("group", { name: "Edit template" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("dialog", { name: "Templates" })).toBeVisible();
  });

  it("deletes a template once the reader confirms", async () => {
    const { ipc, screen } = await shell({ delete_template: null });

    await userEvent.keyboard("{Meta>}j{/Meta}");
    await screen.getByRole("button", { name: "Manage templates…" }).click();
    await screen.getByRole("button", { name: "Delete Every order" }).click();
    expect(ipc.sent("delete_template")).toBeUndefined();
    await screen.getByRole("button", { name: "Delete", exact: true }).click();

    await expect.poll(() => ipc.sent("delete_template")).toEqual({ template_id: "t2" });
  });
});
