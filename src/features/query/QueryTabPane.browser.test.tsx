import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { QueryPlan } from "../../bindings/QueryPlan";
import { type Replies, renderApp, stubIpc } from "../../test/harness";
import { AppShell } from "../shell/AppShell";
import { editor as monaco } from "../sql-editor/monaco";

const postgres: ConnectionRecord = {
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
  created_at: "2026-09-20T00:00:00Z",
};

const bigquery: ConnectionRecord = {
  ...postgres,
  id: "c2",
  label: "Warehouse",
  config: { kind: "bigquery", project_id: "p", location: "US" },
};

const analyzed: QueryPlan = {
  plan: {
    Plan: {
      "Node Type": "Hash Join",
      "Join Type": "Left",
      "Plan Rows": 5,
      "Total Cost": 9,
      "Actual Rows": 4,
      "Actual Loops": 1,
      "Actual Total Time": 2.5,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Schema: "public",
          Alias: "o",
          "Plan Rows": 10,
          "Total Cost": 1.5,
          "Actual Rows": 10,
          "Actual Loops": 1,
          "Actual Total Time": 0.3,
        },
      ],
    },
    "Planning Time": 0.1,
    "Execution Time": 3,
    Settings: {},
  },
  elapsed_ms: 4,
};

async function shell(connection: ConnectionRecord, replies: Replies = {}) {
  const ipc = stubIpc({
    list_connections: [connection],
    running_connection_commands: [],
    language_server_state: { kind: "ready" },
    schema_tree: { schemas: [] },
    check_syntax: [],
    query_history: [],
    ...replies,
  });
  const screen = await renderApp(
    <div className="h-screen">
      <AppShell />
    </div>,
  );
  await screen.getByRole("button", { name: connection.label, exact: true }).click();
  await expect.poll(() => monaco.getEditors().length).toBe(1);
  const editor = monaco.getEditors()[0]!;
  editor.setValue("SELECT * FROM orders o");
  return { ipc, screen, editor };
}

describe("explaining a statement", () => {
  it("asks for the estimate from the button and shows it as a tree", async () => {
    const { ipc, screen } = await shell(postgres, {
      explain_query: {
        plan: { Plan: { "Node Type": "Seq Scan", "Plan Rows": 10, "Total Cost": 1.5 } },
        elapsed_ms: 1,
      },
    });

    await screen.getByRole("button", { name: "Explain" }).click();

    await expect.element(screen.getByText("Estimated")).toBeVisible();
    await expect.element(screen.getByRole("cell", { name: "Seq Scan" })).toBeVisible();
    expect(ipc.sent("explain_query")).toMatchObject({
      connection_id: "c1",
      sql: "SELECT * FROM orders o",
      analyze: false,
    });
  });

  it("analyzes on ⌘⇧E in the editor and shows what each step measured", async () => {
    const { ipc, screen, editor } = await shell(postgres, { explain_query: analyzed });

    editor.focus();
    await userEvent.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");

    await expect.element(screen.getByText("Execution 3 ms")).toBeVisible();
    await expect
      .element(screen.getByRole("row", { name: /Hash Left Join/ }))
      .toHaveTextContent(/Hash Left Join\s*4\s*5\s*1\s*2\.5 ms\s*9/);
    await expect
      .element(screen.getByRole("row", { name: /Seq Scan/ }))
      .toHaveTextContent("public.orders o");
    expect(ipc.sent("explain_query")?.analyze).toBe(true);
  });

  it("offers no plan for BigQuery", async () => {
    const { ipc, screen, editor } = await shell(bigquery);

    await expect.element(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Explain" }).query()).toBeNull();
    editor.focus();
    await userEvent.keyboard("{Meta>}e{/Meta}");
    expect(ipc.sent("explain_query")).toBeUndefined();
  });
});
