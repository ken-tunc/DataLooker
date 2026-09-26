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
      "Hash Cond": "(o.customer_id = c.id)",
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Schema: "public",
          Alias: "o",
          "Plan Rows": 10,
          "Total Cost": 1.5,
          "Actual Rows": 150,
          "Actual Loops": 1,
          "Actual Total Time": 0.3,
          Filter: "(status = 'shipped')",
          "Rows Removed by Filter": 9000,
        },
      ],
    },
    "Planning Time": 0.1,
    "Execution Time": 3,
    Settings: {},
  },
  elapsed_ms: 4,
};

/** Monaco's `CtrlCmd`, which is ⌘ only on a Mac: CI runs on Linux. */
const mod = navigator.userAgent.includes("Macintosh") ? "Meta" : "Control";

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
    await userEvent.keyboard(`{${mod}>}{Shift>}e{/Shift}{/${mod}}`);

    await expect.element(screen.getByText("Execution 3 ms")).toBeVisible();
    await expect
      .element(screen.getByRole("row", { name: /Hash Left Join/ }))
      // Self time, its share of the run, rows, estimated, loops, cost.
      .toHaveTextContent(/Hash Left Join\s*2\.2 ms\s*73%\s*4\s*5\s*1\s*9/);
    await expect
      .element(screen.getByRole("row", { name: /Seq Scan/ }))
      .toHaveTextContent("public.orders o");
    expect(ipc.sent("explain_query")?.analyze).toBe(true);
  });

  it("flags what went wrong and shows a node in full, picked by key or by click", async () => {
    const { screen } = await shell(postgres, { explain_query: analyzed });
    await screen.getByRole("button", { name: "Analyze" }).click();

    const scan = screen.getByRole("row", { name: /Seq Scan/ });
    await expect.element(scan).toHaveTextContent("Filter discarded 98%");
    await expect.element(scan).toHaveTextContent("↑15×");
    const details = screen.getByRole("complementary", { name: "Node details" });
    expect(details.query()).toBeNull();

    await screen.getByRole("group", { name: "Plan" }).click();
    await userEvent.keyboard("{Control>}n{/Control}{Control>}n{/Control}");
    await expect.element(scan).toHaveAttribute("aria-selected", "true");
    await expect.element(details).toHaveTextContent("Rows Removed by Filter");
    // Once: it is a count, so not among the conditions.
    expect(details.element().textContent?.split("Rows Removed by Filter")).toHaveLength(2);
    await expect.element(details).toHaveTextContent("(status = 'shipped')");

    await screen.getByRole("row", { name: /Hash Left Join/ }).click();
    await expect.element(details).toHaveTextContent("(o.customer_id = c.id)");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(scan).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    await expect.element(details).not.toBeInTheDocument();
  });

  it("scrolls a node picked from the keyboard into view", async () => {
    // A chain deep enough to overflow the results pane.
    let deepest: Record<string, unknown> = {
      "Node Type": "Seq Scan",
      "Plan Rows": 1,
      "Total Cost": 1,
    };
    for (let depth = 0; depth < 60; depth += 1) {
      deepest = { "Node Type": "Materialize", "Plan Rows": 1, "Total Cost": 1, Plans: [deepest] };
    }
    const { screen } = await shell(postgres, {
      explain_query: { plan: { Plan: deepest }, elapsed_ms: 1 },
    });
    await screen.getByRole("button", { name: "Explain" }).click();

    const last = screen.getByRole("row", { name: /Seq Scan/ });
    await expect.element(last).not.toBeInViewport();
    // Focused rather than clicked: a click would land on a row and pick it.
    (screen.getByRole("group", { name: "Plan" }).element() as HTMLElement).focus();
    // Up from nothing selected is the last node.
    await userEvent.keyboard("{Control>}p{/Control}");

    await expect.element(last).toHaveAttribute("aria-selected", "true");
    await expect.element(last).toBeInViewport();
  });

  it("offers no plan for BigQuery", async () => {
    const { ipc, screen, editor } = await shell(bigquery);

    await expect.element(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Explain" }).query()).toBeNull();
    editor.focus();
    await userEvent.keyboard(`{${mod}>}e{/${mod}}`);
    expect(ipc.sent("explain_query")).toBeUndefined();
  });
});
