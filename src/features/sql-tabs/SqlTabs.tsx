import type { TabsState } from "./tabs";

type Props = {
  state: TabsState;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
};

export function SqlTabs({ state, onActivate, onClose, onOpen }: Props) {
  return (
    <div role="tablist" className="tabs tabs-lift border-base-300 border-b pt-1 pl-1">
      {state.tabs.map((tab) => (
        // The tab itself is not a button, so that the close button inside it is
        // neither nested in one nor out of the keyboard's reach.
        <div
          key={tab.id}
          role="tab"
          tabIndex={0}
          aria-selected={tab.id === state.activeId}
          className={`tab gap-2 ${tab.id === state.activeId ? "tab-active" : ""}`}
          onClick={() => onActivate(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivate(tab.id);
            }
          }}
        >
          {tab.title}
          <button
            type="button"
            aria-label={`Close ${tab.title}`}
            className="cursor-pointer opacity-40 hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            ✕
          </button>
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
