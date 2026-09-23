import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { SyntaxError } from "../../bindings/SyntaxError";
import { type Ipc, renderApp, stubIpc } from "../../test/harness";
import { editor as monaco } from "./monaco";
import SqlEditor from "./SqlEditor";

const slect: SyntaxError = {
  message: 'syntax error at or near "SLECT"',
  start_line: 1,
  start_column: 1,
  end_line: 1,
  end_column: 6,
};

async function editor(
  replies: Record<string, unknown>,
  sql = "SLECT 1",
  // A model is named after its connection and its tab, and a name Monaco
  // already holds is one it refuses to make a second model for. A connection
  // of its own also gives each test a language client of its own, since a
  // client is made once per connection and kept.
  connectionId: string = crypto.randomUUID(),
) {
  const ipc = stubIpc(replies);
  const tabId = crypto.randomUUID();
  const onChange = vi.fn();
  const onJump = vi.fn();
  // The editor fills what it is given, and what a test gives it is nothing
  // unless it says so: a collapsed editor draws no line to click on.
  const screen = await renderApp(
    <div className="h-72">
      <SqlEditor
        connectionId={connectionId}
        tabId={tabId}
        value={sql}
        onChange={onChange}
        onSubmit={() => {}}
        onJump={onJump}
      />
    </div>,
  );
  const markers = () =>
    monaco.getModelMarkers({
      owner: "datalooker.syntax",
      resource: monaco.getEditors()[0]?.getModel()?.uri,
    });
  const text = () => monaco.getEditors()[0]?.getValue();
  return { ipc, screen, markers, onChange, onJump, text, connectionId };
}

describe("SqlEditor", () => {
  it("marks where the parser says the statement went wrong", async () => {
    const { ipc, markers } = await editor({ check_syntax: [slect] });

    await vi.waitFor(() => expect(markers()).toHaveLength(1), { timeout: 3000 });
    expect(markers()[0]).toMatchObject({
      message: 'syntax error at or near "SLECT"',
      startLineNumber: 1,
      startColumn: 1,
      endColumn: 6,
    });
    expect(ipc.sent("check_syntax")).toEqual({ sql: "SLECT 1" });
  });

  it("leaves the text unmarked when the parser is happy", async () => {
    const { ipc, markers } = await editor({ check_syntax: [] }, "SELECT 1");

    await vi.waitFor(() => expect(ipc.sent("check_syntax")).toBeDefined(), { timeout: 3000 });
    expect(markers()).toEqual([]);
  });

  it("says nothing rather than something wrong when the check itself fails", async () => {
    const { ipc, markers } = await editor({
      check_syntax: () => {
        throw { kind: "Database", message: "the parser is on fire" };
      },
    });

    // Markers are empty before the check runs at all, so the rejection has to
    // have happened for this to say anything.
    await vi.waitFor(() => expect(ipc.sent("check_syntax")).toBeDefined(), { timeout: 3000 });
    expect(markers()).toEqual([]);
  });
});

describe("SqlEditor asked what a name is", () => {
  const STATEMENT = "select * from shop.orders";
  // Monaco reads `CtrlCmd` as ⌘ on a Mac and as Ctrl everywhere else. The app
  // is a Mac one, but the tests also run where the other half of that is true.
  const CTRL_CMD = navigator.userAgent.includes("Mac") ? "Meta" : "Control";
  /** The column before `orders`, counting from one as Monaco does. */
  const ON_ORDERS = STATEMENT.indexOf("orders") + 1;

  it("answers with the name under the cursor when ⌘⇧D is pressed", async () => {
    const { onJump } = await editor({ check_syntax: [] }, STATEMENT);
    const instance = monaco.getEditors()[0];

    instance?.focus();
    instance?.setPosition({ lineNumber: 1, column: ON_ORDERS });
    await userEvent.keyboard(`{${CTRL_CMD}>}{Shift>}D{/Shift}{/${CTRL_CMD}}`);

    await vi.waitFor(() => expect(onJump).toHaveBeenCalledWith({ schema: "shop", name: "orders" }));
  });

  it("answers the same for a ⌘-click, and says nothing for a plain one", async () => {
    const { onJump } = await editor({ check_syntax: [] }, STATEMENT);
    const instance = monaco.getEditors()[0];
    if (!instance) throw new Error("the editor did not mount");

    // Where Monaco drew that column, so that the click lands on the word the
    // way a reader's would.
    const at = instance.getScrolledVisiblePosition({ lineNumber: 1, column: ON_ORDERS });
    const host = instance.getDomNode()?.getBoundingClientRect();
    if (!at || !host) throw new Error("the editor has not been laid out");
    const line = instance.getDomNode()?.querySelector(".view-line");
    const box = line?.getBoundingClientRect();
    if (!line || !box) throw new Error("the line was not drawn");
    const position = {
      x: host.left + at.left + 2 - box.left,
      y: host.top + at.top + at.height / 2 - box.top,
    };

    const locator = page.elementLocator(line);
    await userEvent.click(locator, { position });
    expect(onJump).not.toHaveBeenCalled();

    await userEvent.click(locator, { position, modifiers: [CTRL_CMD] });
    await vi.waitFor(() => expect(onJump).toHaveBeenCalledWith({ schema: "shop", name: "orders" }));
  });
});

/**
 * Vim mode is remembered outside the component — in `localStorage`, and in the
 * module that reads it — so it is whatever the last test or the last run left
 * behind, and a test that assumes it starts off would turn it on by turning it
 * off.
 */
async function vimToggle(screen: Awaited<ReturnType<typeof editor>>["screen"]) {
  const toggle = screen.getByRole("checkbox", { name: "Vim" });
  if ((toggle.element() as HTMLInputElement).checked) await toggle.click();
  return toggle;
}

describe("SqlEditor in vim mode", () => {
  it("takes normal-mode keys once it is turned on, and gives them back", async () => {
    const { screen, text } = await editor({ check_syntax: [] }, "SELECT 1");
    const vim = await vimToggle(screen);

    await vim.click();
    monaco.getEditors()[0]?.focus();
    // `x` deletes a character in normal mode rather than typing one.
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(text()).toBe("ELECT 1"));

    await vim.click();
    monaco.getEditors()[0]?.focus();
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(text()).toBe("xELECT 1"));
  });

  it("leaves the toggle where it was once it is turned off again", async () => {
    const { screen } = await editor({ check_syntax: [] }, "SELECT 1");
    const vim = await vimToggle(screen);
    const at = () => vim.element().getBoundingClientRect().left;
    const before = at();

    await vim.click();
    await expect.element(screen.getByText("--NORMAL--")).toBeVisible();
    await vim.click();

    await vi.waitFor(() => expect(at()).toBe(before));
  });
});

/** Type at the end of the statement, which is what asks for a suggestion. */
async function typing(text: string) {
  const instance = monaco.getEditors()[0];
  const model = instance?.getModel();
  if (!instance || !model) throw new Error("there is no editor to type in");
  instance.setPosition(model.getFullModelRange().getEndPosition());
  instance.focus();
  await userEvent.keyboard(text);
}

/**
 * A language server, as far as the window can tell one from the outside: it
 * takes messages, and it answers a question about a position the way the
 * backend announces an answer.
 */
function server() {
  let ipc: Ipc | undefined;
  const sent: string[] = [];
  const replies = {
    check_syntax: [],
    start_language_server: {},
    send_to_language_server: (args: Record<string, unknown>) => {
      const asked = JSON.parse(args.message as string) as { id?: number; method: string };
      sent.push(asked.method);
      if (asked.method === "textDocument/completion") {
        ipc?.emit("lsp:message", {
          connection_id: args.connectionId as string,
          payload: JSON.stringify({
            jsonrpc: "2.0",
            id: asked.id,
            result: { items: [{ label: "orders", kind: 7, detail: "table" }] },
          }),
        });
      }
      return null;
    },
  };
  return { replies, sent, listenWith: (made: Ipc) => (ipc = made) };
}

describe("SqlEditor completion", () => {
  it("offers what the connection's language server suggests", async () => {
    const { replies, sent, listenWith } = server();
    const made = await editor(replies, "SELECT * FROM");
    listenWith(made.ipc);

    await typing(" ord");

    // The label is drawn in pieces — the part already typed is marked — so
    // what is read here is the row rather than a run of text.
    const offered = page.getByRole("option");
    await expect.element(offered).toBeVisible();
    expect(offered.element().textContent).toContain("orders");
    expect(offered.element().textContent).toContain("table");

    // The document was announced before it was asked about, and the statement
    // went with it.
    expect(sent[0]).toBe("textDocument/didOpen");
    expect(made.ipc.sent("start_language_server")).toEqual({ connectionId: made.connectionId });
  });

  it("asks nobody when there is no server to ask", async () => {
    const { ipc } = await editor(
      {
        check_syntax: [],
        start_language_server: () => {
          throw { kind: "NotFound", message: "sqls is not installed" };
        },
      },
      "SELECT * FROM",
    );
    await typing(" ord");

    // A server that is not there is asked for once and then left alone: the
    // editor works without completion rather than trying again per keystroke.
    await vi.waitFor(() =>
      expect(ipc.calls.filter((call) => call.command === "start_language_server")).toHaveLength(1),
    );
    expect(ipc.calls.map((call) => call.command)).not.toContain("send_to_language_server");
  });
  it("starts no server for a tab nothing is asked about", async () => {
    const { replies } = server();
    const { ipc } = await editor(replies, "SELECT 1");

    // Opening a tab is not asking for completion, and starting a server reads
    // the whole schema of the reader's database.
    await vi.waitFor(() => expect(ipc.calls.map((call) => call.command)).toContain("check_syntax"));
    expect(ipc.calls.map((call) => call.command)).not.toContain("start_language_server");
  });

  it("tells the next server about the document when one has ended", async () => {
    const { replies, sent, listenWith } = server();
    const made = await editor(replies, "SELECT * FROM");
    listenWith(made.ipc);
    await typing(" ord");
    await expect.element(page.getByRole("option")).toBeVisible();

    // The server dies, and the editor goes on being an editor.
    made.ipc.emit("lsp:exit", { connection_id: made.connectionId });
    sent.length = 0;
    // Away with the list that is up: typing on inside a word it is already
    // showing filters that list rather than asking again.
    await userEvent.keyboard("{Escape}");
    await typing("e");

    // A new server knows nothing about the document, so it is told again
    // before it is asked anything.
    await vi.waitFor(() => expect(sent).toContain("textDocument/completion"));
    expect(sent[0]).toBe("textDocument/didOpen");
    expect(made.ipc.calls.filter((call) => call.command === "start_language_server")).toHaveLength(
      2,
    );
  });
  it("says nothing to a new server about a change meant for the one before", async () => {
    let ipc: Ipc | undefined;
    let holding = false;
    const held: (() => void)[] = [];
    const sent: string[] = [];
    const replies = {
      check_syntax: [],
      start_language_server: {},
      send_to_language_server: (args: Record<string, unknown>) => {
        const asked = JSON.parse(args.message as string) as { id?: number; method: string };
        sent.push(asked.method);
        if (asked.method === "textDocument/completion") {
          ipc?.emit("lsp:message", {
            connection_id: args.connectionId as string,
            payload: JSON.stringify({ jsonrpc: "2.0", id: asked.id, result: { items: [] } }),
          });
        }
        // A server that has stopped reading, so that what follows waits.
        return holding ? new Promise((resolve) => held.push(() => resolve(null))) : null;
      },
    };

    const made = await editor(replies, "SELECT * FROM");
    ipc = made.ipc;
    await typing(" ord");
    await vi.waitFor(() => expect(sent).toContain("textDocument/completion"));

    holding = true;
    await typing("e");
    await vi.waitFor(() => expect(held).toHaveLength(1));
    sent.length = 0;
    // Waiting behind the one on the wire.
    await typing("r");

    made.ipc.emit("lsp:exit", { connection_id: made.connectionId });
    holding = false;
    for (const release of held) release();

    // What was waiting was a change to a document this server has never heard
    // of, so what it is told is that the document exists.
    await vi.waitFor(() => expect(sent).toContain("textDocument/didOpen"));
    expect(sent).not.toContain("textDocument/didChange");
  });
  it("completes once a server has been built for a connection that had none", async () => {
    let installed = false;
    let ipc: Ipc | undefined;
    const replies = {
      check_syntax: [],
      language_server_state: () =>
        installed ? { kind: "ready" } : { kind: "missing", server: "sqls" },
      install_language_server: () => {
        installed = true;
        return null;
      },
      start_language_server: () => {
        if (!installed) throw { kind: "NotFound", message: "sqls is not installed" };
        return {};
      },
      send_to_language_server: (args: Record<string, unknown>) => {
        const asked = JSON.parse(args.message as string) as { id?: number; method: string };
        if (asked.method === "textDocument/completion") {
          ipc?.emit("lsp:message", {
            connection_id: args.connectionId as string,
            payload: JSON.stringify({
              jsonrpc: "2.0",
              id: asked.id,
              result: { items: [{ label: "orders", kind: 7, detail: "table" }] },
            }),
          });
        }
        return null;
      },
    };

    const made = await editor(replies, "SELECT * FROM");
    ipc = made.ipc;
    await typing(" ord");
    expect(page.getByRole("option").elements()).toEqual([]);

    await made.screen.getByText("Install sqls for completion").click();

    // The client asked for a server once and was told there was none; the
    // install is what makes it ask again.
    await userEvent.keyboard("{Escape}");
    await typing("e");
    await expect.element(page.getByRole("option")).toBeVisible();
  });
});

/** A BigQuery connection, which the analyzer completes rather than a server. */
function bigquery(connectionId: string) {
  return [
    {
      id: connectionId,
      label: "BigQuery",
      config: { kind: "bigquery", project_id: "shop", location: "US" },
      command: null,
      created_at: "2026-09-23 00:00:00",
    },
  ];
}

describe("SqlEditor completion of BigQuery", () => {
  it("offers what the analyzer says can go at the cursor", async () => {
    const connectionId = crypto.randomUUID();
    const made = await editor(
      {
        check_syntax: [],
        list_connections: bigquery(connectionId),
        complete: {
          kind: "names",
          replace: { start: 9, end: 9 },
          expected_type: null,
          candidates: [
            { name: "total", kind: "field", type_name: "NUMERIC", qualifier: null, depth: 0 },
          ],
        },
      },
      "SELECT o",
      connectionId,
    );
    // The connections are read before the editor knows whom to ask.
    await vi.waitFor(() => expect(made.ipc.sent("list_connections")).toBeDefined());

    await typing(".");

    const offered = page.getByRole("option");
    await expect.element(offered).toBeVisible();
    expect(offered.element().textContent).toContain("total");
    expect(offered.element().textContent).toContain("NUMERIC");
    // The whole document and the cursor in the units the editor counts.
    expect(made.ipc.sent("complete")).toEqual({ connectionId, text: "SELECT o.", cursor: 9 });
    expect(made.ipc.calls.map((call) => call.command)).not.toContain("start_language_server");
  });

  it("offers a dataset's tables out of the schema tree", async () => {
    const connectionId = crypto.randomUUID();
    const made = await editor(
      {
        check_syntax: [],
        list_connections: bigquery(connectionId),
        complete: {
          kind: "tables",
          replace: { start: 20, end: 21 },
          path: ["sales"],
        },
        schema_tree: {
          schemas: [{ name: "sales", tables: [{ name: "orders", kind: "table" }] }],
        },
      },
      "SELECT * FROM sales.",
      connectionId,
    );
    await vi.waitFor(() => expect(made.ipc.sent("list_connections")).toBeDefined());

    await typing("o");

    const offered = page.getByRole("option");
    await expect.element(offered).toBeVisible();
    expect(offered.element().textContent).toContain("orders");
  });

  it("offers nothing where the analyzer cannot be had", async () => {
    const connectionId = crypto.randomUUID();
    const made = await editor(
      {
        check_syntax: [],
        list_connections: bigquery(connectionId),
        complete: () => {
          throw { kind: "NotFound", message: "datalooker-bigquery-analyzer is not installed" };
        },
      },
      "SELECT o",
      connectionId,
    );
    await vi.waitFor(() => expect(made.ipc.sent("list_connections")).toBeDefined());

    await typing(".");

    await vi.waitFor(() => expect(made.ipc.sent("complete")).toBeDefined());
    expect(page.getByRole("option").elements()).toEqual([]);
  });
});
