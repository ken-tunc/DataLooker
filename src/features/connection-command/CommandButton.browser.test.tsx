import { describe, expect, it } from "vite-plus/test";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { renderApp, stubIpc } from "../../test/harness";
import { CommandButton } from "./CommandButton";

const TUNNEL = "ssh -N -L 5432:db.internal:5432 bastion";

const connection: ConnectionRecord = {
  id: "id-1",
  label: "Local",
  config: {
    kind: "postgres",
    host: "localhost",
    port: 5432,
    database: "datalooker",
    username: "admin",
  },
  command: TUNNEL,
  created_at: "2026-09-20T00:00:00Z",
};

async function button(replies: Parameters<typeof stubIpc>[0] = {}) {
  const ipc = stubIpc({
    running_connection_commands: [],
    run_connection_command: null,
    stop_connection_command: null,
    ...replies,
  });
  const screen = await renderApp(<CommandButton connection={connection} command={TUNNEL} />);
  return { ipc, screen };
}

describe("CommandButton", () => {
  it("starts the connection's command", async () => {
    const { ipc, screen } = await button();

    await screen.getByRole("button", { name: "Run the command for Local" }).click();

    await expect.poll(() => ipc.sent("run_connection_command")).toEqual({ connectionId: "id-1" });
  });

  it("offers to stop what is already running, and says which command it is", async () => {
    const { ipc, screen } = await button({ running_connection_commands: ["id-1"] });

    const stop = screen.getByRole("button", { name: "Stop the command for Local" });
    await expect.element(stop).toHaveAttribute("title", `Stop ${TUNNEL}`);
    await stop.click();

    await expect.poll(() => ipc.sent("stop_connection_command")).toEqual({ connectionId: "id-1" });
  });

  it("shows what the backend refused to run", async () => {
    const { screen } = await button({
      run_connection_command: () => {
        throw { kind: "Shell", message: "/bin/zsh: No such file or directory" };
      },
    });

    await screen.getByRole("button", { name: "Run the command for Local" }).click();

    await expect
      .element(screen.getByText("Local: /bin/zsh: No such file or directory"))
      .toBeVisible();
  });
});
