import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { SyntaxError } from "../../bindings/SyntaxError";
import { renderApp, stubIpc } from "../../test/harness";
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
  const onChange = vi.fn();
  const onJump = vi.fn();
  // The editor fills what it is given, and what a test gives it is nothing
  // unless it says so: a collapsed editor draws no line to click on.
  const screen = await renderApp(
    <div className="h-72">
      <SqlEditor value={sql} onChange={onChange} onSubmit={() => {}} onJump={onJump} />
    </div>,
  );
  const markers = () => monaco.getModelMarkers({ owner: "datalooker.syntax" });
  const text = () => monaco.getEditors()[0]?.getValue();
  return { ipc, screen, markers, onChange, onJump, text };
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
  /** The column before `orders`, counting from one as Monaco does. */
  const ON_ORDERS = STATEMENT.indexOf("orders") + 1;

  it("answers with the name under the cursor when ⌘⇧D is pressed", async () => {
    const { onJump } = await editor({ check_syntax: [] }, STATEMENT);
    const instance = monaco.getEditors()[0];

    instance?.focus();
    instance?.setPosition({ lineNumber: 1, column: ON_ORDERS });
    await userEvent.keyboard("{Meta>}{Shift>}D{/Shift}{/Meta}");

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

    await userEvent.click(locator, { position, modifiers: ["Meta"] });
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
