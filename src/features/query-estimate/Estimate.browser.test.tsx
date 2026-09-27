import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp, stubIpc } from "../../test/harness";
import { Estimate } from "./Estimate";

/** A statement the test can change, as typing in the editor would. */
function Typing({ to }: { to: string }) {
  const [sql, setSql] = useState("select 1");
  return (
    <>
      <button type="button" onClick={() => setSql(to)}>
        Type
      </button>
      <Estimate connectionId="bq" sql={sql} />
    </>
  );
}

describe("Estimate", () => {
  it("dims the last answer while the statement has not settled", async () => {
    stubIpc({ estimate_query: { bytes: 2048, at_least: false, unpruned: [] } });
    await renderApp(<Typing to="select 2" />);
    const answer = page.getByText("2.0 KiB · ≈ < $0.01");
    await expect.element(answer).toBeVisible();
    expect(answer.element().parentElement?.className).not.toContain("opacity-60");

    await userEvent.click(page.getByRole("button", { name: "Type" }));

    expect(answer.element().parentElement?.className).toContain("opacity-60");
  });

  it("shows nothing once the statement is cleared", async () => {
    stubIpc({ estimate_query: { bytes: 2048, at_least: false, unpruned: [] } });
    await renderApp(<Typing to="  " />);
    await expect.element(page.getByText("2.0 KiB · ≈ < $0.01")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Type" }));

    // At once, not when the debounce lets the query go.
    expect(page.getByText("2.0 KiB · ≈ < $0.01").query()).toBeNull();
  });

  it("gives only a floor when the statement runs SQL from a string", async () => {
    stubIpc({ estimate_query: { bytes: 1024 ** 4, at_least: true, unpruned: [] } });
    await renderApp(<Estimate connectionId="bq" sql="EXECUTE IMMEDIATE @sql" />);

    await expect.element(page.getByText("≥ 1.0 TiB · ≥ $6.25")).toBeVisible();
  });
});
