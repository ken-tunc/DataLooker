import { useState } from "react";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { renderApp, stubIpc } from "../../test/harness";
import { ConnectionHeader } from "./ConnectionHeader";
import { ConnectionRail } from "./ConnectionRail";

const local: ConnectionRecord = {
  id: "id-1",
  label: "Local",
  config: {
    kind: "postgres",
    host: "localhost",
    port: 5432,
    database: "datalooker",
    username: "admin",
  },
  command: null,
  command_while_selected: false,
  time_zone: null,
  created_at: "2026-09-20T00:00:00Z",
};

/** The rail, and the header of whichever connection it put in front, as the shell lays them out. */
function Host() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <>
      <ConnectionRail selectedId={selectedId} onSelect={setSelectedId} onShowShortcuts={() => {}} />
      {selectedId && (
        <ConnectionHeader connectionId={selectedId} onRemoved={() => setSelectedId(null)} />
      )}
    </>
  );
}

async function sidebar(replies: Parameters<typeof stubIpc>[0]) {
  const ipc = stubIpc(replies);
  const screen = await renderApp(<Host />);

  /**
   * A connection's actions are in the header once it is in front, behind a ⋯
   * menu that starts closed.
   */
  const actions = async (label: string, action: string) => {
    await screen.getByRole("button", { name: label, exact: true }).click();
    await screen.getByLabelText(`${label} actions`).click();
    await screen.getByRole("button", { name: action, exact: true }).click();
  };

  return { ipc, screen, actions };
}

describe("the connection rail", () => {
  it("lists what the backend holds, and names the one put in front", async () => {
    const { screen } = await sidebar({
      list_connections: [local, { ...local, id: "id-2", label: "Staging" }],
    });

    await expect.element(screen.getByRole("button", { name: "Local", exact: true })).toBeVisible();
    // A tile shows the driver's mark over the name.
    await expect.element(screen.getByText("Staging", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "PostgreSQL" }).first()).toBeVisible();

    await screen.getByRole("button", { name: "Staging", exact: true }).click();

    await expect.element(screen.getByRole("heading", { name: "Staging" })).toBeVisible();
    await expect.element(screen.getByText("localhost:5432/datalooker")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Staging", exact: true }))
      .toHaveAttribute("aria-current", "true");
  });

  it("shows the database's own complaint, and can ask again", async () => {
    let attempts = 0;
    const { screen } = await sidebar({
      list_connections: () => {
        attempts += 1;
        if (attempts === 1) throw { kind: "Database", message: "meta.db is locked" };
        return [local];
      },
    });

    await expect
      .element(screen.getByRole("button", { name: "Retry" }))
      .toHaveAttribute("title", "meta.db is locked");
    await screen.getByRole("button", { name: "Retry" }).click();

    await expect.element(screen.getByRole("button", { name: "Local", exact: true })).toBeVisible();
  });

  it("closes its menu on a press outside it, and once an item is chosen", async () => {
    const { screen, actions } = await sidebar({ list_connections: [local], test_connection: 12 });
    const test = screen.getByRole("button", { name: "Test", exact: true });

    await screen.getByRole("button", { name: "Local", exact: true }).click();
    await screen.getByLabelText("Local actions").click();
    await expect.element(test).toBeVisible();
    await screen.getByRole("heading", { name: "Local" }).click();
    // A closed menu is out of the accessibility tree, so its items are not found.
    await expect.poll(() => test.query()).toBeNull();

    await actions("Local", "Test");
    await expect.element(screen.getByText("Reached Local in 12 ms")).toBeVisible();
    await expect.poll(() => test.query()).toBeNull();
  });

  it("reports how long a test took, in a toast", async () => {
    const { screen, actions } = await sidebar({ list_connections: [local], test_connection: 12 });

    await actions("Local", "Test");

    await expect.element(screen.getByText("Reached Local in 12 ms")).toBeVisible();
  });

  it("names the failure a test hit, rather than a message of its own", async () => {
    const { screen, actions } = await sidebar({
      list_connections: [local],
      test_connection: () => {
        throw { kind: "Database", message: "password authentication failed" };
      },
    });

    await actions("Local", "Test");

    await expect.element(screen.getByText("password authentication failed")).toBeVisible();
  });

  it("asks before deleting, and sends the id when told to", async () => {
    const { ipc, screen, actions } = await sidebar({
      list_connections: [local],
      delete_connection: null,
    });

    await actions("Local", "Delete");
    await expect.element(screen.getByText("Delete Local?")).toBeVisible();
    expect(ipc.sent("delete_connection")).toBeUndefined();

    // The header's menu holds a Delete of its own, so this one is the dialog's.
    await screen.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();

    await expect.element(screen.getByText("Deleted Local")).toBeVisible();
    expect(ipc.sent("delete_connection")).toEqual({ connection_id: "id-1" });
    // Nothing is in front any more, so there is no header to act on.
    expect(screen.getByRole("heading", { name: "Local" }).elements()).toEqual([]);
  });
});

describe("the order of the rail", () => {
  const labels = ["One", "Two", "Three"];

  /** A backend that keeps the order it is sent, or refuses to when told to. */
  async function reorderable(refuse = false) {
    let order = labels.map((label, index) => ({ ...local, id: `id-${index + 1}`, label }));
    const rail = await sidebar({
      list_connections: () => order,
      reorder_connections: ({ connection_ids }) => {
        if (refuse) throw { kind: "Database", message: "meta.db is locked" };
        order = connection_ids.flatMap((id) => order.find((record) => record.id === id) ?? []);
        return null;
      },
    });
    const tile = (label: string) => rail.screen.getByRole("button", { name: label, exact: true });
    const shown = () =>
      rail.screen
        .getByRole("navigation")
        .getByRole("listitem")
        .elements()
        .map((item) => item.querySelector("button")?.getAttribute("aria-label"))
        .filter((label) => label && labels.includes(label));
    await expect.element(tile("Three")).toBeVisible();
    return { ...rail, tile, shown };
  }

  it("puts a tile where it is dropped, and keeps it there", async () => {
    const { ipc, tile, shown } = await reorderable();

    await userEvent.dragAndDrop(tile("One"), tile("Three"));

    await expect.poll(shown).toEqual(["Two", "Three", "One"]);
    expect(ipc.sent("reorder_connections")).toEqual({ connection_ids: ["id-2", "id-3", "id-1"] });
    // Read again from the backend after the write, and still in that order.
    await expect
      .poll(() => ipc.calls.filter((c) => c.command === "list_connections").length)
      .toBe(2);
    expect(shown()).toEqual(["Two", "Three", "One"]);
  });

  it("moves the focused tile with ⌥↑ and ⌥↓, and keeps the focus on it", async () => {
    const { ipc, tile, shown } = await reorderable();

    await tile("Three").click();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await expect.poll(shown).toEqual(["One", "Three", "Two"]);
    await expect.element(tile("Three")).toHaveFocus();

    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await expect.poll(shown).toEqual(["Three", "One", "Two"]);
    expect(ipc.sent("reorder_connections")).toEqual({ connection_ids: ["id-3", "id-1", "id-2"] });

    // Nowhere further up to go.
    const writes = ipc.calls.length;
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await userEvent.keyboard("{ArrowDown}");
    expect(ipc.calls.slice(writes).map((c) => c.command)).not.toContain("reorder_connections");
  });

  it("sends one move only after the one before it is written", async () => {
    let order = labels.map((label, index) => ({ ...local, id: `id-${index + 1}`, label }));
    const sent: string[][] = [];
    let release = () => {};
    const { screen, ipc } = await sidebar({
      list_connections: () => order,
      reorder_connections: async ({ connection_ids }) => {
        sent.push(connection_ids);
        // The first write is slow, so a second sent alongside it would land first.
        if (sent.length === 1) await new Promise<void>((resolve) => (release = resolve));
        order = connection_ids.flatMap((id) => order.find((record) => record.id === id) ?? []);
        return null;
      },
    });
    const three = screen.getByRole("button", { name: "Three", exact: true });

    await three.click();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await expect.poll(() => sent.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toHaveLength(1);

    release();
    await expect
      .poll(() => sent)
      .toEqual([
        ["id-1", "id-3", "id-2"],
        ["id-3", "id-1", "id-2"],
      ]);
    await expect.poll(() => order.map((record) => record.label)).toEqual(["Three", "One", "Two"]);
    expect(ipc.sent("reorder_connections")).toEqual({ connection_ids: ["id-3", "id-1", "id-2"] });
  });

  it("puts the tiles back, and says why, when the order cannot be kept", async () => {
    const { screen, tile, shown } = await reorderable(true);

    await tile("One").click();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");

    await expect.element(screen.getByText("meta.db is locked")).toBeVisible();
    expect(shown()).toEqual(["One", "Two", "Three"]);
  });
});

describe("a connection's command", () => {
  const tunnelled: ConnectionRecord = { ...local, command: "ssh -N -L 5432:db:5432 bastion" };

  it("is offered only where there is one to run", async () => {
    const { ipc, screen } = await sidebar({
      list_connections: [local],
      running_connection_commands: [],
    });

    await screen.getByRole("button", { name: "Local", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Local" })).toBeVisible();
    expect(screen.getByLabelText("Run the command for Local").elements()).toEqual([]);
    // Nothing was asked on behalf of a connection with no command to run.
    expect(ipc.calls.map((call) => call.command)).not.toContain("running_connection_commands");
  });

  it("tells the reader when one dies on its own, and what it last said", async () => {
    const { ipc, screen } = await sidebar({
      list_connections: [tunnelled],
      running_connection_commands: ["id-1"],
    });
    // The rail says the tunnel is up before the connection is even in front.
    await expect.element(screen.getByText("Command running")).toBeInTheDocument();

    ipc.emit("shell:exit", {
      connection_id: "id-1",
      code: 255,
      stopped: false,
      output: "ssh: connect to host bastion port 22: Connection refused",
    });

    await expect
      .element(screen.getByText(/Local: the command exited with 255 — ssh: connect to host/))
      .toBeVisible();
  });

  it("says nothing about one the reader stopped, and offers to run it again", async () => {
    let running = ["id-1"];
    const { ipc, screen } = await sidebar({
      list_connections: [tunnelled],
      running_connection_commands: () => running,
      stop_connection_command: () => {
        running = [];
        return null;
      },
    });

    await screen.getByRole("button", { name: "Local", exact: true }).click();
    await screen.getByLabelText("Stop the command for Local").click();
    ipc.emit("shell:exit", { connection_id: "id-1", code: null, stopped: true, output: "" });

    await expect.element(screen.getByLabelText("Run the command for Local")).toBeVisible();
    expect(screen.getByText("Command running").elements()).toEqual([]);
    expect(screen.getByTestId("toast").elements()).toEqual([]);
  });
});

describe("a connection of another kind", () => {
  it("asks for what BigQuery needs, and sends that", async () => {
    const { ipc, screen } = await sidebar({ list_connections: [], save_connection: "id-9" });

    await screen.getByRole("button", { name: "New connection" }).click();
    await screen.getByLabelText("Driver").selectOptions("BigQuery");

    // The fields of the driver that was not picked are not on screen at all.
    expect(screen.getByLabelText("Host").elements()).toEqual([]);
    await screen.getByLabelText("Label").fill("Warehouse");
    await screen.getByLabelText("Project").fill("looking");
    await screen.getByLabelText("Location").fill("asia-northeast1");
    await screen.getByLabelText("Service account key").fill('{"type":"service_account"}');
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .poll(() => ipc.sent("save_connection"))
      .toEqual({
        id: null,
        label: "Warehouse",
        config: { kind: "bigquery", project_id: "looking", location: "asia-northeast1" },
        secret: '{"type":"service_account"}',
        command: null,
        command_while_selected: false,
        time_zone: null,
      });
  });

  it("says which project a BigQuery connection reads", async () => {
    const { screen } = await sidebar({
      list_connections: [
        {
          ...local,
          label: "Warehouse",
          config: { kind: "bigquery", project_id: "looking", location: "EU" },
        },
      ],
    });

    await screen.getByRole("button", { name: "Warehouse", exact: true }).click();
    await expect.element(screen.getByText("looking · EU")).toBeVisible();
  });
});
