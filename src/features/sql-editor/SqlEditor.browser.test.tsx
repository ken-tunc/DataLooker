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

async function editor(replies: Record<string, unknown>, sql = "SLECT 1") {
  const ipc = stubIpc(replies);
  // A model is named after its connection and its tab, and a name Monaco
  // already holds is one it refuses to make a second model for. A connection
  // of its own also gives each test a language client of its own, since a
  // client is made once per connection and kept.
  const connectionId = crypto.randomUUID();
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

describe("SqlEditor completion", () => {
  it("offers what the connection's language server suggests", async () => {
    let ipc: Ipc | undefined;
    const sent: string[] = [];
    // Standing in for the server: whatever the editor asks about a position,
    // the answer comes back the way the backend announces one.
    const answering = (args: Record<string, unknown>) => {
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
    };

    const made = await editor(
      {
        check_syntax: [],
        start_language_server: {},
        send_to_language_server: answering,
      },
      "SELECT * FROM",
    );
    ipc = made.ipc;

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
});
