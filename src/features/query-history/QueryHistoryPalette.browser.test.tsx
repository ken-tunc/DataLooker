import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { HistoryEntry } from "../../bindings/HistoryEntry";
import { type Replies, renderApp, stubIpc } from "../../test/harness";
import { QueryHistoryPalette } from "./QueryHistoryPalette";

const entry = (id: number, sql: string, rest: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  sql,
  ran_at: "2026-09-21T09:30:00.000Z",
  duration_ms: 4,
  row_count: 1,
  error: null,
  source: "reader",
  ...rest,
});

const log: HistoryEntry[] = [
  entry(3, "SELECT * FROM orders"),
  entry(2, "SLECT 1", { row_count: null, error: "Database error: syntax error" }),
  entry(1, "SELECT * FROM people\nWHERE id = 1"),
];

async function palette(replies: Replies = { query_history: log }) {
  stubIpc(replies);
  const onOpenQuery = vi.fn();
  const onClose = vi.fn();
  const screen = await renderApp(
    <QueryHistoryPalette connectionId="c1" onOpenQuery={onOpenQuery} onClose={onClose} />,
  );
  const find = screen.getByRole("combobox", { name: "Search the queries you have run" });
  return { screen, find, onOpenQuery, onClose };
}

describe("QueryHistoryPalette", () => {
  it("lists what was run, newest first and on one line", async () => {
    const { screen } = await palette();

    await expect.poll(() => screen.getByRole("option").elements()).toHaveLength(3);
    await expect
      .element(screen.getByRole("option", { name: /SELECT \* FROM people WHERE id = 1/ }))
      .toBeVisible();
  });

  it("says which run failed", async () => {
    const { screen } = await palette();

    await expect.element(screen.getByRole("option", { name: /SLECT 1 failed/ })).toBeVisible();
  });

  it("opens the statement the arrow keys land on", async () => {
    const { find, onOpenQuery, onClose } = await palette();

    await find.fill("people");
    await userEvent.keyboard("{Enter}");

    expect(onOpenQuery).toHaveBeenCalledWith("SELECT * FROM people\nWHERE id = 1");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("says so rather than showing a stale list", async () => {
    const { screen, find } = await palette();

    await find.fill("zzz");

    await expect.element(screen.getByText("No query matches.")).toBeVisible();
  });

  it("shows what reading the history complained about", async () => {
    const { screen } = await palette({
      query_history: () => {
        throw { kind: "Database", message: "meta.db is locked" };
      },
    });

    await expect.element(screen.getByText("meta.db is locked")).toBeVisible();
  });
  it("marks a run an agent asked for, and leaves the reader's unmarked", async () => {
    const { screen } = await palette({
      query_history: [entry(1, "SELECT 1"), entry(2, "SELECT 2", { source: "agent" })],
    });

    await expect.element(screen.getByText("agent")).toBeVisible();
    expect(screen.getByText("agent").elements()).toHaveLength(1);
  });
});
