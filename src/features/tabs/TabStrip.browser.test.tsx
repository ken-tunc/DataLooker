import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { renderApp } from "../../test/harness";
import { activateTab, closeTab, openSqlTab, type TabsState } from "./tabs";
import { TabStrip } from "./TabStrip";

/** The strip over the real `tabs.ts`, not a stand-in. */
function Strip({ count }: { count: number }) {
  const [state, setState] = useState<TabsState | null>(() => {
    let built: TabsState | undefined;
    for (let n = 1; n <= count; n++) built = openSqlTab(built, `tab-${n}`);
    // Opening leaves the newest in front, and a walk of the strip reads better
    // from its start.
    return built ? activateTab(built, "tab-1") : null;
  });

  if (!state) return <p>Nothing open</p>;
  return (
    <TabStrip
      state={state}
      onActivate={(id) => setState(activateTab(state, id))}
      onClose={(id) => setState(closeTab(state, id))}
      onOpen={() => setState(openSqlTab(state, crypto.randomUUID()))}
    />
  );
}

async function strip(count = 3) {
  const screen = await renderApp(<Strip count={count} />);
  const tabs = () => [
    ...document.querySelectorAll<HTMLElement>(
      '[role="tablist"][aria-label="Open tabs"] [role="tab"]',
    ),
  ];
  const titleOf = (tab: Element | null | undefined) => tab?.textContent?.trim();
  return {
    screen,
    tabs,
    titles: () => tabs().map((tab) => titleOf(tab)),
    focused: () => titleOf(document.activeElement),
    selected: () => titleOf(tabs().find((tab) => tab.getAttribute("aria-selected") === "true")),
  };
}

describe("TabStrip", () => {
  it("puts the tab in front in the keyboard's way, and the others behind it", async () => {
    const { tabs, selected } = await strip();

    expect(selected()).toBe("Query 1");
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });

  it("brings forward the tab that was clicked", async () => {
    const { screen, selected } = await strip();

    await screen.getByRole("tab", { name: /Query 2/ }).click();

    expect(selected()).toBe("Query 2");
  });

  it("walks the strip with the arrows, activating what it lands on", async () => {
    const { screen, focused, selected } = await strip();
    await screen.getByRole("tab", { name: /Query 1/ }).click();

    await userEvent.keyboard("{ArrowRight}");

    expect(focused()).toBe("Query 2");
    expect(selected()).toBe("Query 2");
  });

  it("wraps at either end, so that holding an arrow cycles", async () => {
    const { screen, selected } = await strip();
    await screen.getByRole("tab", { name: /Query 1/ }).click();

    await userEvent.keyboard("{ArrowLeft}");
    expect(selected()).toBe("Query 3");

    await userEvent.keyboard("{ArrowRight}");
    expect(selected()).toBe("Query 1");
  });

  it("jumps to either end on Home and End", async () => {
    const { screen, selected } = await strip();
    await screen.getByRole("tab", { name: /Query 1/ }).click();

    await userEvent.keyboard("{End}");
    expect(selected()).toBe("Query 3");

    await userEvent.keyboard("{Home}");
    expect(selected()).toBe("Query 1");
  });

  it("closes the tab in focus on Delete, and stays in the strip", async () => {
    const { screen, titles, focused } = await strip();
    await screen.getByRole("tab", { name: /Query 2/ }).click();

    await userEvent.keyboard("{Delete}");

    expect(titles()).toEqual(["Query 1", "Query 3"]);
    // Focus went with the tab that was closed; the strip takes it back, or the
    // keyboard's walk would end here.
    await expect.poll(focused).toBe("Query 3");
  });

  it("closes a tab the mouse clicks the close mark of without bringing it forward", async () => {
    const { screen, titles, selected } = await strip();

    await screen.getByTitle("Close Query 3 (Delete)").click();

    expect(titles()).toEqual(["Query 1", "Query 2"]);
    expect(selected()).toBe("Query 1");
  });

  it("says that nothing is open once the last tab is closed", async () => {
    const { screen } = await strip(1);

    await screen.getByTitle("Close Query 1 (Delete)").click();

    await expect.element(screen.getByText("Nothing open")).toBeVisible();
  });

  it("opens a tab in front of the others", async () => {
    const { screen, titles, selected } = await strip();

    await screen.getByRole("button", { name: "New query tab" }).click();

    expect(titles()).toEqual(["Query 1", "Query 2", "Query 3", "Query 4"]);
    expect(selected()).toBe("Query 4");
  });
});
