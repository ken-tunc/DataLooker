import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { QueryResult } from "../../bindings/QueryResult";
import { renderApp } from "../../test/harness";
import { ResultGrid } from "./ResultGrid";

const document = { customer: { name: "Ada Lovelace", tags: ["first", "programmer"] } };

const result: QueryResult = {
  columns: [
    { name: "id", type_name: "INT8" },
    { name: "payload", type_name: "JSONB" },
  ],
  rows: [[1, document]],
  truncated: false,
  elapsed_ms: 1,
};

async function grid() {
  // The virtualizer draws rows only into a scroller with a height.
  return renderApp(
    <div style={{ height: 200, width: 400 }}>
      <ResultGrid result={result} />
    </div>,
  );
}

describe("ResultGrid", () => {
  it("shows a value the cell cuts short in full, with its nesting", async () => {
    const screen = await grid();

    await userEvent.hover(screen.getByText(/^\{"customer"/));

    const peek = screen.getByRole("tooltip");
    await expect.element(peek).toBeVisible();
    expect(peek.element().textContent).toBe(JSON.stringify(document, null, 2));

    await userEvent.keyboard("{Escape}");
    await expect.element(peek).not.toBeInTheDocument();
  });

  it("opens the selected cell in full on Space, and ties the view to the cell", async () => {
    const screen = await grid();
    const cell = screen.getByText(/^\{"customer"/);

    await cell.click();
    await expect.element(screen.getByRole("grid")).toHaveFocus();
    await userEvent.keyboard(" ");

    const peek = screen.getByRole("tooltip");
    await expect.element(peek).toBeVisible();
    await expect.element(cell).toHaveAttribute("aria-describedby", peek.element().id);

    await userEvent.keyboard(" ");
    await expect.element(peek).not.toBeInTheDocument();
  });

  it("leaves Space to a cell being edited", async () => {
    const screen = await renderApp(
      <div style={{ height: 200, width: 400 }}>
        <ResultGrid result={result} editing={{ pendingValue: () => undefined, onEdit: () => {} }} />
      </div>,
    );

    await screen.getByText("1", { exact: true }).dblClick();
    await userEvent.keyboard(" 2");

    await expect.element(screen.getByRole("textbox", { name: "id" })).toHaveValue("1 2");
    expect(screen.getByRole("tooltip").query()).toBeNull();
  });

  it("leaves a value the cell shows whole alone", async () => {
    const screen = await grid();

    await userEvent.hover(screen.getByText("1", { exact: true }));
    // Past the delay a cut-short value would open after.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(screen.getByRole("tooltip").query()).toBeNull();
  });
});
