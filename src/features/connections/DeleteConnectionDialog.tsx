import { useEffect, useRef } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";

type Props = {
  connection: ConnectionRecord;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export function DeleteConnectionDialog({ connection, pending, onConfirm, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal backdrop-blur-sm"
      onClose={onClose}
      // Escape and the backdrop would unmount the dialog mid-delete, and the
      // mutation's callbacks go with it — no toast, no refreshed list.
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <div className="modal-box">
        <h3 className="text-lg font-semibold">Delete {connection.label}?</h3>
        <p className="py-4">Its password is removed from the keychain as well.</p>
        <div className="modal-action">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && <span className="loading loading-spinner loading-xs" />}
            Delete
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={pending}>
          Close
        </button>
      </form>
    </dialog>
  );
}
