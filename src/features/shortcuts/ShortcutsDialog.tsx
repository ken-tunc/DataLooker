import { useEffect, useId, useRef } from "react";
import { SHORTCUT_GROUPS } from "./shortcuts";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal backdrop-blur-sm"
      aria-labelledby={heading}
      onClose={onClose}
    >
      <div className="modal-box max-w-2xl">
        <h3 id={heading} className="text-lg font-semibold">
          Keyboard shortcuts
        </h3>
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h4 className="text-base-content/60 mb-1 text-xs font-semibold uppercase">
                {group.title}
              </h4>
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-sm">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.what} className="contents">
                    <dt className="flex gap-1 whitespace-nowrap">
                      {shortcut.keys.map((keys) => (
                        <kbd key={keys} className="kbd kbd-sm">
                          {keys}
                        </kbd>
                      ))}
                    </dt>
                    <dd>{shortcut.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal-action">
          {/* Closed natively rather than unmounted open: closing is what
              hands focus back to whatever held it before the dialog. */}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" tabIndex={-1}>
          Close
        </button>
      </form>
    </dialog>
  );
}
