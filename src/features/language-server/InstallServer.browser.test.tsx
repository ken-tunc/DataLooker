import { describe, expect, it } from "vite-plus/test";
import { renderApp, stubIpc } from "../../test/harness";
import { InstallServer } from "./InstallServer";

async function footer(replies: Record<string, unknown>) {
  const ipc = stubIpc(replies);
  const screen = await renderApp(<InstallServer connectionId="c1" />);
  return { ipc, screen };
}

const offer = () => "Install sqls for completion";

describe("InstallServer", () => {
  it("offers to build a server where the connection has none", async () => {
    const { ipc, screen } = await footer({
      language_server_state: { kind: "missing", server: "sqls" },
      install_language_server: null,
    });

    await screen.getByText(offer()).click();

    expect(ipc.sent("install_language_server")).toEqual({ connectionId: "c1" });
  });

  it("says nothing where there is a server", async () => {
    const { screen } = await footer({ language_server_state: { kind: "ready" } });
    expect(screen.getByText(offer()).elements()).toEqual([]);
  });

  it("names the server the connection would be completed against", async () => {
    const { screen } = await footer({
      language_server_state: { kind: "missing", server: "datalooker-bigquery-analyzer" },
      install_language_server: null,
    });

    await expect
      .element(screen.getByText("Install datalooker-bigquery-analyzer for completion"))
      .toBeVisible();
  });

  it("says what went wrong when the build fails, and offers again", async () => {
    const { screen } = await footer({
      language_server_state: { kind: "missing", server: "sqls" },
      install_language_server: () => {
        throw { kind: "NotFound", message: "Go, which is what builds a language server" };
      },
    });

    await screen.getByText(offer()).click();

    await expect
      .element(screen.getByText("Go, which is what builds a language server"))
      .toBeVisible();
    await expect.element(screen.getByText(offer())).toBeVisible();
  });
  it("leaves a server the reader named themselves to them", async () => {
    const { screen } = await footer({
      language_server_state: {
        kind: "named",
        message: "DATALOOKER_SQLS_BIN names /nowhere/sqls, where there is no file",
      },
    });

    // Building one would not be used, so what is offered is the reason.
    await expect.element(screen.getByText("DATALOOKER_SQLS_BIN", { exact: false })).toBeVisible();
    expect(screen.getByText(offer()).elements()).toEqual([]);
  });
});
