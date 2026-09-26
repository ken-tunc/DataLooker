import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { QueryResult } from "../../bindings/QueryResult";
import { saveTextFile } from "../../lib/files";
import { renderApp, stubIpc } from "../../test/harness";
import { ResultGrid } from "./ResultGrid";

// The dialog and the write are Tauri's; what is handed to them is the grid's.
vi.mock("../../lib/files", () => ({ saveTextFile: vi.fn() }));

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
      // ⌘C on a Mac, and Control-C everywhere else.
      for (const key of ["Meta", "Control"]) {
        written.mockClear();
        await userEvent.keyboard(`{${key}>}c{/${key}}`);
        expect(written).toHaveBeenCalledWith(JSON.stringify(document));
      }
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

  describe("a range", () => {
    const people: QueryResult = {
      columns: [
        { name: "id", type_name: "INT4", instant: false },
        { name: "name", type_name: "TEXT", instant: false },
        { name: "note", type_name: "TEXT", instant: false },
      ],
      rows: [
        [1, "Ada", null],
        [2, "Grace", "it's"],
        [3, "Edsger", "x"],
      ],
      truncated: false,
      elapsed_ms: 1,
    };

    async function peopleGrid(props: Partial<Parameters<typeof ResultGrid>[0]> = {}) {
      return renderApp(
        <div style={{ height: 300, width: 600 }}>
          <ResultGrid result={people} connectionId="c1" {...props} />
        </div>,
      );
    }

    const selectedTexts = (screen: Awaited<ReturnType<typeof peopleGrid>>) =>
      [...screen.getByRole("grid").element().querySelectorAll('[aria-selected="true"]')].map(
        (cell) => cell.textContent,
      );

    async function copied(action: () => Promise<unknown>): Promise<string | undefined> {
      const written = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      try {
        await action();
        return written.mock.calls.at(-1)?.[0];
      } finally {
        written.mockRestore();
      }
    }

    it("is stretched with a shift-click and copied as rows of tab-separated cells", async () => {
      const screen = await peopleGrid();

      await screen.getByText("Ada").click();
      await screen.getByText("x", { exact: true }).click({ modifiers: ["Shift"] });

      expect(selectedTexts(screen)).toEqual(["Ada", "NULL", "Grace", "it's", "Edsger", "x"]);
      const text = await copied(() => userEvent.keyboard("{Meta>}c{/Meta}"));
      expect(text).toBe("Ada\t\nGrace\tit's\nEdsger\tx");
    });

    it("is stretched with shift and the arrows, to the edge with ⌘", async () => {
      const screen = await peopleGrid();

      await screen.getByText("1", { exact: true }).click();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      expect(selectedTexts(screen)).toEqual(["1", "Ada"]);
      await userEvent.keyboard("{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}");
      expect(selectedTexts(screen)).toEqual(["1", "Ada", "2", "Grace", "3", "Edsger"]);

      // An arrow alone starts over from the cell the range began at.
      await userEvent.keyboard("{ArrowRight}");
      expect(selectedTexts(screen)).toEqual(["Ada"]);
    });

    it("is stretched by dragging across the cells", async () => {
      const screen = await peopleGrid();

      await userEvent.dragAndDrop(
        screen.getByText("1", { exact: true }),
        screen.getByText("Grace"),
      );

      expect(selectedTexts(screen)).toEqual(["1", "Ada", "2", "Grace"]);
    });

    it("takes every cell on ⌘A, and copies them with their headers from the menu", async () => {
      const screen = await peopleGrid();

      await screen.getByText("Ada").click();
      await userEvent.keyboard("{Meta>}a{/Meta}");
      expect(selectedTexts(screen)).toHaveLength(9);

      await screen.getByText("Grace").click({ button: "right" });
      const text = await copied(() =>
        screen.getByRole("menuitem", { name: "Copy with headers" }).click(),
      );
      expect(text).toBe("id\tname\tnote\n1\tAda\t\n2\tGrace\tit's\n3\tEdsger\tx");
      await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
      await expect.element(screen.getByRole("grid")).toHaveFocus();
    });

    it("starts over at a cell right-clicked outside it", async () => {
      const screen = await peopleGrid();

      await screen.getByText("Ada").click();
      await screen.getByText("Grace").click({ modifiers: ["Shift"] });
      await screen.getByText("Edsger").click({ button: "right" });

      expect(selectedTexts(screen)).toEqual(["Edsger"]);
      const text = await copied(() =>
        screen.getByRole("menuitem", { name: "Copy as Markdown" }).click(),
      );
      expect(text).toBe("| name |\n| --- |\n| Edsger |");
    });

    it("is copied as an INSERT only when the rows are a PostgreSQL table's", async () => {
      const table = { schema: "public", table: "people" };
      const connection = (config: ConnectionRecord["config"]): ConnectionRecord => ({
        id: "c1",
        label: "Local",
        config,
        command: null,
        command_while_selected: false,
        time_zone: null,
        created_at: "2026-09-20T00:00:00Z",
      });

      stubIpc({
        list_connections: [connection({ kind: "bigquery", project_id: "p", location: "US" })],
      });
      const bare = await peopleGrid({ table });
      await bare.getByText("Ada").click({ button: "right" });
      await expect.element(bare.getByRole("menuitem", { name: "Copy as JSON" })).toBeVisible();
      expect(bare.getByRole("menuitem", { name: "Copy as INSERT" }).query()).toBeNull();
      await userEvent.keyboard("{Escape}");
      await bare.unmount();

      stubIpc({
        list_connections: [
          connection({
            kind: "postgres",
            host: "localhost",
            port: 5432,
            database: "shop",
            username: "admin",
          }),
        ],
      });
      const screen = await peopleGrid({ table });
      await screen.getByText("2", { exact: true }).click();
      await screen.getByText("it's").click({ modifiers: ["Shift"] });
      await screen.getByText("Grace").click({ button: "right" });
      const text = await copied(() =>
        screen.getByRole("menuitem", { name: "Copy as INSERT" }).click(),
      );
      expect(text).toBe(
        `INSERT INTO "public"."people" ("id", "name", "note") VALUES\n  (2, 'Grace', 'it''s');`,
      );
    });

    it("saves every row, not only the selected ones, and says when there are more", async () => {
      const save = vi.mocked(saveTextFile);
      save.mockResolvedValue("people.csv");
      const screen = await peopleGrid({
        result: { ...people, truncated: true },
        fileName: "people",
      });

      await screen.getByText("Ada").click({ button: "right" });
      await screen.getByRole("menuitem", { name: "Save all as CSV…" }).click();

      expect(save).toHaveBeenCalledWith(
        "people",
        "csv",
        "id,name,note\n1,Ada,\n2,Grace,it's\n3,Edsger,x",
      );
      await expect
        .element(
          screen.getByText("Saved 3 rows to people.csv — only the rows shown, not all there are."),
        )
        .toBeVisible();
    });
  });
});
