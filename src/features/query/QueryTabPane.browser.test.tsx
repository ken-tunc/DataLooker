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
  production: false,
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
          "Actual Startup Time": 0.004,
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
    await expect.element(screen.getByRole("gridcell", { name: "Seq Scan" })).toBeVisible();
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

    await screen.getByRole("grid", { name: "Plan" }).click();
    await userEvent.keyboard("{Control>}n{/Control}{Control>}n{/Control}");
    await expect.element(scan).toHaveAttribute("aria-selected", "true");
    await expect.element(details).toHaveTextContent("Rows Removed by Filter");
    // Once: it is a count, so not among the conditions.
    expect(details.element().textContent?.split("Rows Removed by Filter")).toHaveLength(2);
    await expect.element(details).toHaveTextContent("(status = 'shipped')");
    // To the microsecond, as PostgreSQL wrote it.
    await expect.element(details).toHaveTextContent(/Actual Startup Time\s*0\.004/);
    const plan = screen.getByRole("grid", { name: "Plan" });
    await expect.element(plan).toHaveAttribute("aria-activedescendant", scan.element().id);

    await screen.getByRole("row", { name: /Hash Left Join/ }).click();
    await expect.element(details).toHaveTextContent("(o.customer_id = c.id)");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(scan).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    await expect.element(details).not.toBeInTheDocument();

    await scan.click();
    await details.getByRole("button", { name: "Close the details" }).click();
    await expect.element(details).not.toBeInTheDocument();
    await expect.element(plan).toHaveFocus();
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
    (screen.getByRole("grid", { name: "Plan" }).element() as HTMLElement).focus();
    // Up from nothing selected is the last node.
    await userEvent.keyboard("{Control>}p{/Control}");

    await expect.element(last).toHaveAttribute("aria-selected", "true");
    await expect.element(last).toBeInViewport();
  });

  it("draws the plan as a graph that shares its selection with the table", async () => {
    const { screen } = await shell(postgres, { explain_query: analyzed });
    await screen.getByRole("button", { name: "Analyze" }).click();
    await screen.getByRole("button", { name: "Graph" }).click();

    const graph = screen.getByRole("tree", { name: "Plan graph" });
    await expect.element(graph).toBeVisible();
    const scan = graph.getByRole("treeitem", { name: /^Seq Scan, public\.orders o, 150 rows/ });
    await scan.click();
    const details = screen.getByRole("complementary", { name: "Node details" });
    await expect.element(details).toHaveTextContent("(status = 'shipped')");
    await expect.element(graph).toHaveAttribute("aria-activedescendant", scan.element().id);
    // Two nodes, one line between them, as wide as the rows it carries.
    expect(graph.element().querySelectorAll("path title")).toHaveLength(1);
    expect(graph.element().querySelector("path title")?.textContent).toBe("150 rows");

    await screen.getByRole("button", { name: "Table" }).click();
    await expect
      .element(screen.getByRole("row", { name: /Seq Scan/ }))
      .toHaveAttribute("aria-selected", "true");

    // The tab keeps the shape for the next plan it shows.
    await screen.getByRole("button", { name: "Graph" }).click();
    await screen.getByRole("button", { name: "Analyze" }).click();
    await expect.element(screen.getByRole("tree", { name: "Plan graph" })).toBeVisible();
  });

  it("keeps a node picked in the graph in view once its details open", async () => {
    // Wider than any viewport at the smallest zoom: twenty scans under one append.
    const scans = Array.from({ length: 20 }, (_, i) => ({
      "Node Type": "Seq Scan",
      "Relation Name": `part_${i}`,
      "Plan Rows": 1,
      "Total Cost": 1,
    }));
    const { screen } = await shell(postgres, {
      explain_query: {
        plan: { Plan: { "Node Type": "Append", "Plan Rows": 20, "Total Cost": 20, Plans: scans } },
        elapsed_ms: 1,
      },
    });
    await screen.getByRole("button", { name: "Explain" }).click();
    await screen.getByRole("button", { name: "Graph" }).click();
    const graph = screen.getByRole("tree", { name: "Plan graph" });
    const last = graph.getByRole("treeitem", { name: /^Seq Scan, part_19,/ });
    const inside = () => {
      const box = last.element().getBoundingClientRect();
      const view = graph.element().getBoundingClientRect();
      return box.left >= view.left && box.right <= view.right;
    };
    await expect.element(last).toBeInTheDocument();
    expect(inside()).toBe(false);

    (graph.element() as HTMLElement).focus();
    await userEvent.keyboard("{Control>}p{/Control}");

    await expect
      .element(screen.getByRole("complementary", { name: "Node details" }))
      .toHaveTextContent("part_19");
    await expect.poll(inside).toBe(true);

    // The reader's own pan takes it away again, and it stays away.
    graph
      .element()
      .dispatchEvent(new WheelEvent("wheel", { deltaX: -2000, bubbles: true, cancelable: true }));
    await expect.poll(inside).toBe(false);
    await new Promise((settled) => setTimeout(settled, 200));
    expect(inside()).toBe(false);

    // Nor does hiding the tab and showing it again, as switching tabs does.
    const shown = () => graph.element().querySelector("svg > g")?.getAttribute("transform");
    const panned = shown();
    const pane = graph.element().parentElement!;
    pane.style.display = "none";
    await new Promise((settled) => setTimeout(settled, 200));
    pane.style.display = "";
    await new Promise((settled) => setTimeout(settled, 200));
    expect(shown()).toBe(panned);
  });

  it("counts a node's rows over its loops as a whole number", async () => {
    const { screen } = await shell(postgres, {
      explain_query: {
        plan: {
          Plan: {
            "Node Type": "Index Scan",
            "Plan Rows": 2,
            "Total Cost": 1,
            "Actual Rows": 2.55,
            "Actual Loops": 389,
            "Actual Total Time": 0.001,
          },
          "Execution Time": 1,
        },
        elapsed_ms: 1,
      },
    });
    await screen.getByRole("button", { name: "Analyze" }).click();
    await screen.getByRole("button", { name: "Graph" }).click();

    // 2.55 rows a loop is an average: 389 loops of it came to 992 rows, not 991.95.
    await expect
      .element(screen.getByRole("treeitem", { name: /^Index Scan/ }))
      .toHaveTextContent("992 rows");
  });

  it("zooms the graph about the pointer and fits it back", async () => {
    const { screen } = await shell(postgres, { explain_query: analyzed });
    await screen.getByRole("button", { name: "Analyze" }).click();
    await screen.getByRole("button", { name: "Graph" }).click();
    const graph = screen.getByRole("tree", { name: "Plan graph" });
    await expect.element(graph).toBeVisible();
    const drawn = () => graph.element().querySelector("svg > g")?.getAttribute("transform");
    // Drawn once the viewport has been measured, and listened to a frame later.
    await expect.poll(drawn).toBeTruthy();
    await new Promise(requestAnimationFrame);
    const fitted = drawn();

    // A pinch, as macOS delivers one.
    graph.element().dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -50,
        ctrlKey: true,
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      }),
    );
    await expect.poll(drawn).not.toBe(fitted);
    expect(drawn()).toMatch(/scale\(1\.6/);

    await screen.getByRole("button", { name: "Fit the plan" }).click();
    await expect.poll(drawn).toBe(fitted);
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

describe("going to the table a name means", () => {
  const table = (name: string) => ({ name, kind: "table" as const });

  /** ⌘⇧D with the cursor in `orders`, which `shell` writes. */
  async function jump(replies: Replies) {
    const { screen, editor } = await shell(postgres, replies);
    editor.focus();
    editor.setPosition({ lineNumber: 1, column: "SELECT * FROM or".length });
    await userEvent.keyboard(`{${mod}>}{Shift>}d{/Shift}{/${mod}}`);
    return screen;
  }

  /** A message is all that happens: no table opens and no chooser. */
  function wentNowhere(screen: Awaited<ReturnType<typeof jump>>) {
    expect(screen.getByRole("tab", { name: /orders/ }).query()).toBeNull();
    expect(screen.getByPlaceholder("Find a table").query()).toBeNull();
  }

  it("opens the structure of the one table it names", async () => {
    const screen = await jump({
      schema_tree: { schemas: [{ name: "public", tables: [table("orders"), table("items")] }] },
    });

    await expect
      .element(screen.getByRole("tab", { name: "public.orders" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("lets the reader choose when the name is in several schemas", async () => {
    const screen = await jump({
      schema_tree: {
        schemas: [
          { name: "public", tables: [table("orders")] },
          { name: "archive", tables: [table("orders")] },
        ],
      },
    });

    await expect.element(screen.getByPlaceholder("Find a table")).toHaveValue("orders");
    expect(screen.getByRole("tab", { name: /orders/ }).query()).toBeNull();
  });

  it("says so when no table has the name", async () => {
    const screen = await jump({
      schema_tree: { schemas: [{ name: "public", tables: [table("items")] }] },
    });

    await expect.element(screen.getByText("No table here is called orders.")).toBeVisible();
    wentNowhere(screen);
  });

  it("claims nothing while the schema is still being read", async () => {
    const screen = await jump({ schema_tree: () => new Promise(() => {}) });

    await expect.element(screen.getByText("The schema is still being read.")).toBeVisible();
    wentNowhere(screen);
  });

  it("says why no name can be looked up when the schema could not be read", async () => {
    const screen = await jump({
      schema_tree: () => {
        throw { kind: "Database", message: "permission denied for schema public" };
      },
    });

    await expect
      .element(screen.getByText(/permission denied for schema public — no name can be looked up/))
      .toBeVisible();
    wentNowhere(screen);
  });
});

describe("running a statement that is easy to regret", () => {
  const nothing = { columns: [], rows: [], truncated: false, elapsed_ms: 1 };
  const deleting = {
    statement: "DELETE FROM public.users",
    hazard: "delete_without_where" as const,
    targets: ["public.users"],
  };

  it("runs a statement with nothing to ask about straight away", async () => {
    const { ipc, screen } = await shell(postgres, { statement_risks: [], execute_query: nothing });

    await screen.getByRole("button", { name: "Run" }).click();

    await expect.element(screen.getByText("The statement returned no rows.")).toBeVisible();
    expect(ipc.sent("statement_risks")).toEqual({
      connection_id: "c1",
      sql: "SELECT * FROM orders o",
    });
  });

  it("says what it would do and runs nothing when the reader backs out", async () => {
    const { ipc, screen, editor } = await shell(postgres, {
      statement_risks: [deleting],
      execute_query: nothing,
    });
    editor.setValue(deleting.statement);

    await screen.getByRole("button", { name: "Run" }).click();

    const dialog = screen.getByRole("dialog", { name: "Run this statement?" });
    await expect.element(dialog.getByText("Deletes every row of public.users.")).toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(ipc.sent("execute_query")).toBeUndefined();
  });

  it("runs it once the reader confirms", async () => {
    const { ipc, screen, editor } = await shell(postgres, {
      statement_risks: [deleting],
      execute_query: nothing,
    });
    editor.setValue(deleting.statement);

    await screen.getByRole("button", { name: "Run" }).click();
    await screen
      .getByRole("dialog", { name: "Run this statement?" })
      .getByRole("button", { name: "Run" })
      .click();

    await expect.element(screen.getByText("The statement returned no rows.")).toBeVisible();
    expect(ipc.sent("execute_query")).toMatchObject({ sql: deleting.statement });
  });
});

describe("a statement that cannot be asked about", () => {
  it("says why and runs nothing", async () => {
    const { ipc, screen } = await shell(postgres, {
      statement_risks: () => {
        throw { kind: "Database", message: "the connection could not be read" };
      },
      execute_query: { columns: [], rows: [], truncated: false, elapsed_ms: 1 },
    });

    await screen.getByRole("button", { name: "Run" }).click();

    await expect.element(screen.getByText("the connection could not be read")).toBeVisible();
    expect(ipc.sent("execute_query")).toBeUndefined();
  });
});
