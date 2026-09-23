import { describe, expect, it } from "vite-plus/test";
import { renderApp, stubIpc } from "../../test/harness";
import { AgentAccess } from "./AgentAccess";

const shut = { enabled: false, token: "", port: 0 };
const open = { enabled: true, token: "a-secret-token", port: 41234 };

async function agents(replies: Record<string, unknown>) {
  const ipc = stubIpc(replies);
  const screen = await renderApp(<AgentAccess />);
  await screen.getByRole("button", { name: "Agents" }).click();
  return { ipc, screen };
}

describe("AgentAccess", () => {
  it("says nothing to hand over while it is shut", async () => {
    const { screen } = await agents({ agent_access: shut });

    // The dialog says what it is, rather than being announced as "dialog".
    await expect.element(screen.getByRole("dialog", { name: "Agents" })).toBeVisible();
    await expect.element(screen.getByText("Answer agents")).toBeVisible();
    expect(screen.getByLabelText("Token", { exact: true }).elements()).toEqual([]);
  });

  it("opens the door and shows what to hand an agent", async () => {
    const { ipc, screen } = await agents({ agent_access: shut, set_agent_access: open });

    await screen.getByRole("checkbox").click();

    expect(ipc.sent("set_agent_access")).toEqual({ enabled: true });
    await expect
      .element(screen.getByLabelText("Address", { exact: true }))
      .toHaveValue("http://127.0.0.1:41234/mcp");
    await expect
      .element(screen.getByLabelText("Token", { exact: true }))
      .toHaveValue("a-secret-token");
  });

  it("shuts it again, and says what went wrong when it cannot", async () => {
    const { ipc, screen } = await agents({
      agent_access: open,
      set_agent_access: () => {
        throw { kind: "Shell", message: "no port for agents to reach" };
      },
    });

    await screen.getByRole("checkbox").click();

    expect(ipc.sent("set_agent_access")).toEqual({ enabled: false });
    await expect.element(screen.getByText("no port for agents to reach")).toBeVisible();
  });
});
