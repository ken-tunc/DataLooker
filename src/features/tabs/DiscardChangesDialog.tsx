import { useEffect, useId, useRef } from "react";

type Props = {
  title: string;
  onDiscard: () => void;
  onClose: () => void;
};

export function DiscardChangesDialog({ title, onDiscard, onClose }: Props) {
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
      <div className="modal-box">
        <h3 id={heading} className="text-lg font-semibold">
          Close {title}?
        </h3>
        <p className="py-4">Its unsaved changes are discarded.</p>
        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Keep editing
          </button>
          <button type="button" className="btn btn-warning" onClick={onDiscard}>
            Discard changes
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">Close</button>
      </form>
    </dialog>
  );
}
