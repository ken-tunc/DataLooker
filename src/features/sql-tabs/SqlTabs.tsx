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
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={tab.id === state.activeId}
          className={`tab gap-2 ${tab.id === state.activeId ? "tab-active" : ""}`}
          onClick={() => onActivate(tab.id)}
        >
          {tab.title}
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Close ${tab.title}`}
            className="opacity-40 hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            ✕
          </span>
        </button>
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
