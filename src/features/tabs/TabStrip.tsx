import { Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import type { Tab, TabsState } from "./tabs";

type Props = {
  state: TabsState;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
};

const unsaved = (tab: Tab) => tab.kind === "table" && tab.unsaved;

/** The tabs are siblings in the strip, in the order they are rendered. */
function focusTabAt(sibling: HTMLElement, index: number): void {
  sibling.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
}

export function TabStrip({ state, onActivate, onClose, onOpen }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  // Closing the focused tab would drop focus on the document. The tab is
  // remembered, not the wish to close it: one with unsaved changes asks first.
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    const closed = refocus.current;
    if (closed === null || state.tabs.some((tab) => tab.id === closed)) return;
    refocus.current = null;
    strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>, id: string) {
    // Space on the close button closes rather than activates.
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
      // Activation follows focus, as with ⌃Tab.
      const wrapped = ((target % state.tabs.length) + state.tabs.length) % state.tabs.length;
      focusTabAt(event.currentTarget, wrapped);
      const focused = state.tabs[wrapped];
      if (focused) onActivate(focused.id);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      refocus.current = id;
      onClose(id);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(id);
    }
  }

  return (
    <div
      ref={strip}
      role="tablist"
      // A table tab holds a tablist of its own.
      aria-label="Open tabs"
      className="tabs tabs-lift min-w-0 flex-1 self-end pl-1"
    >
      {state.tabs.map((tab) => (
        // ARIA makes a tab's contents presentational, so the close mark is for
        // the mouse; the keyboard closes with Delete.
        <div
          key={tab.id}
          role="tab"
          tabIndex={tab.id === state.activeId ? 0 : -1}
          aria-selected={tab.id === state.activeId}
          aria-label={unsaved(tab) ? `${tab.title}, unsaved changes` : undefined}
          className={`tab gap-2 ${tab.id === state.activeId ? "tab-active" : ""}`}
          onClick={() => onActivate(tab.id)}
          onKeyDown={(event) => onTabKeyDown(event, tab.id)}
        >
          {tab.title}
          {unsaved(tab) && (
            <span aria-hidden="true" title="Unsaved changes" className="status status-warning" />
          )}
          <span
            aria-hidden="true"
            title={`Close ${tab.title} (Delete)`}
            className="cursor-pointer rounded opacity-40 hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            <X className="size-3.5" />
          </span>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square ml-1 self-center"
        aria-label="New query tab"
        onClick={onOpen}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
