import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { QueryResult } from "../../bindings/QueryResult";
import { renderApp } from "../../test/harness";
import { ResultGrid } from "./ResultGrid";

const document = { customer: { name: "Ada Lovelace", tags: ["first", "programmer"] } };

const result: QueryResult = {
  columns: [
    { name: "id", type_name: "INT8", instant: false },
    { name: "payload", type_name: "JSONB", instant: false },
  ],
  rows: [[1, document]],
  truncated: false,
  elapsed_ms: 1,
};

async function grid() {
  // The virtualizer draws rows only into a scroller with a height.
  return renderApp(
    <div style={{ height: 200, width: 400 }}>
      <ResultGrid result={result} connectionId="c1" />
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
        <ResultGrid
          result={result}
          editing={{ pendingValue: () => undefined, onEdit: () => {} }}
          connectionId="c1"
        />
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

  it("moves the selection with the arrows and stops at the edges", async () => {
    const screen = await renderApp(
      <div style={{ height: 200, width: 400 }}>
        <ResultGrid
          result={{
            ...result,
            rows: [
              [1, "a"],
              [2, "b"],
            ],
          }}
          connectionId="c1"
        />
      </div>,
    );
    const selected = () =>
      screen.getByRole("grid").element().querySelector('[aria-selected="true"]')?.textContent;

    await screen.getByText("1", { exact: true }).click();
    await userEvent.keyboard("{ArrowRight}");
    expect(selected()).toBe("a");
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    expect(selected()).toBe("b");
    await userEvent.keyboard("{ArrowDown}{ArrowLeft}{ArrowLeft}");
    expect(selected()).toBe("2");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(selected()).toBe("1");
  });

  it("copies the selected cell as the grid writes it", async () => {
    const written = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    try {
      const screen = await grid();

      await screen.getByText(/^\{"customer"/).click();
      await userEvent.keyboard("{Control>}c{/Control}");

      expect(written).toHaveBeenCalledWith(JSON.stringify(document));
    } finally {
      written.mockRestore();
    }
  });

  it("widens a column dragged wider, and fits it again on a double-click", async () => {
    const screen = await grid();
    const header = screen.getByRole("columnheader", { name: /^id/ });
    const width = () => header.element().getBoundingClientRect().width;
    const fitted = width();

    await userEvent.dragAndDrop(screen.getByRole("separator", { name: "Resize id" }), header, {
      targetPosition: { x: fitted + 80, y: 5 },
    });
    await expect.poll(width).toBeGreaterThan(fitted + 40);

    await screen.getByRole("separator", { name: "Resize id" }).dblClick();
    await expect.poll(width).toBe(fitted);
  });
});
