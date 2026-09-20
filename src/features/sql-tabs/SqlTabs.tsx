import type { KeyboardEvent } from "react";
import type { TabsState } from "./tabs";

type Props = {
  state: TabsState;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
};

/** The tabs are siblings in the strip, in the order they are rendered. */
function focusTabAt(sibling: HTMLElement, index: number): void {
  sibling.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
}

export function SqlTabs({ state, onActivate, onClose, onOpen }: Props) {
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>, id: string) {
    // Space on the close button would otherwise activate the tab here instead
    // of closing it.
    if (event.target !== event.currentTarget) return;

    const index = state.tabs.findIndex((tab) => tab.id === id);
    const targets: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: state.tabs.length - 1,
    };
    const target = targets[event.key];
    if (target !== undefined) {
      event.preventDefault();
      // The arrows wrap, so holding one cycles the strip; activation follows
      // focus, which is what ⌃Tab does too.
      const wrapped = ((target % state.tabs.length) + state.tabs.length) % state.tabs.length;
      focusTabAt(event.currentTarget, wrapped);
      const focused = state.tabs[wrapped];
      if (focused) onActivate(focused.id);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onClose(id);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(id);
    }
  }

  return (
    <div role="tablist" className="tabs tabs-lift border-base-300 border-b pt-1 pl-1">
      {state.tabs.map((tab) => (
        // Only the active tab is in the tab order; the arrows move between
        // them, and Delete closes the one in focus — ARIA makes whatever sits
        // inside a tab presentational, so the ✕ is for the mouse alone.
        <div
          key={tab.id}
          role="tab"
          tabIndex={tab.id === state.activeId ? 0 : -1}
          aria-selected={tab.id === state.activeId}
          className={`tab gap-2 ${tab.id === state.activeId ? "tab-active" : ""}`}
          onClick={() => onActivate(tab.id)}
          onKeyDown={(event) => onTabKeyDown(event, tab.id)}
        >
          {tab.title}
          <span
            aria-hidden="true"
            title={`Close ${tab.title} (Delete)`}
            className="cursor-pointer opacity-40 hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            ✕
          </span>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-xs ml-1 self-center"
        aria-label="New query tab"
        onClick={onOpen}
      >
        +
      </button>
    </div>
  );
}
