import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
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
  const screen = await renderApp(<SqlEditor value={sql} onChange={onChange} onSubmit={() => {}} />);
  const markers = () => monaco.getModelMarkers({ owner: "datalooker.syntax" });
  const text = () => monaco.getEditors()[0]?.getValue();
  return { ipc, screen, markers, onChange, text };
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
    const { markers } = await editor({
      check_syntax: () => {
        throw { kind: "Database", message: "the parser is on fire" };
      },
    });

    await vi.waitFor(() => expect(markers()).toEqual([]), { timeout: 3000 });
  });
});

describe("SqlEditor in vim mode", () => {
  it("takes normal-mode keys once it is turned on, and gives them back", async () => {
    const { screen, text } = await editor({ check_syntax: [] }, "SELECT 1");
    const vim = screen.getByRole("checkbox", { name: "Vim" });

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
});
