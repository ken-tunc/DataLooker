import { describe, expect, it } from "vite-plus/test";
import type { TransactionState } from "../../bindings/TransactionState";
import { renderApp, stubIpc } from "../../test/harness";
import { TransactionControls } from "./TransactionControls";

const RESULT = { columns: [], rows: [], truncated: false, elapsed_ms: 1 };

/** A session whose state the statements sent to it move, as the server's would. */
async function controls(initial: TransactionState) {
  let state = initial;
  const ipc = stubIpc({
    transaction_state: () => state,
    query_history: [],
    execute_query: () => {
      state = "idle";
      return RESULT;
    },
  });
  const screen = await renderApp(<TransactionControls connectionId="id-1" />);
  return { ipc, screen };
}

describe("TransactionControls", () => {
  it("shows nothing while no transaction is open", async () => {
    const { ipc, screen } = await controls("idle");

    await expect.poll(() => ipc.sent("transaction_state")).toEqual({ connection_id: "id-1" });
    expect(screen.container.textContent).toBe("");
  });

  it("commits an open transaction on the reader's session, and then says nothing", async () => {
    const { ipc, screen } = await controls("open");

    await expect.element(screen.getByText("Transaction open")).toBeVisible();
    await screen.getByRole("button", { name: "Commit" }).click();

    await expect.poll(() => ipc.sent("execute_query")?.sql).toBe("COMMIT");
    expect(ipc.sent("execute_query")?.connection_id).toBe("id-1");
    await expect.element(screen.getByText("Transaction open")).not.toBeInTheDocument();
  });

  it("offers only to roll back a failed transaction", async () => {
    const { ipc, screen } = await controls("failed");

    await expect.element(screen.getByText("Transaction failed")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Roll back" }).click();

    await expect.poll(() => ipc.sent("execute_query")?.sql).toBe("ROLLBACK");
    await expect.element(screen.getByText("Transaction failed")).not.toBeInTheDocument();
  });
});
