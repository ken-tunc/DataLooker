type Props<T extends string> = {
  label: string;
  views: readonly { value: T; label: string }[];
  shown: T;
  onShow: (value: T) => void;
};

/**
 * Chooses how the same thing is shown: a table's rows or its structure, a
 * plan as a table or a graph. `tabs-xs` in a box stands as tall as a `btn-sm`,
 * so it sits in a toolbar beside one.
 */
export function ViewSwitch<T extends string>({ label, views, shown, onShow }: Props<T>) {
  return (
    <div role="tablist" aria-label={label} className="tabs tabs-box tabs-xs shrink-0">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          role="tab"
          aria-selected={view.value === shown}
          className={`tab ${view.value === shown ? "tab-active" : ""}`}
          onClick={() => onShow(view.value)}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}
