import { useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { ConnectionList } from "./ConnectionList";
import type { FormMode } from "./form";
import { useConnections, useDeleteConnection } from "./hooks";

type Editing = { mode: FormMode; source: ConnectionRecord | null };

export function ConnectionsPage() {
  const { show } = useToast();
  const connections = useConnections();
  const remove = useDeleteConnection();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ConnectionRecord | null>(null);

  function confirmDelete(connection: ConnectionRecord) {
    remove.mutate(connection.id, {
      onSuccess: () => {
        show(`Deleted ${connection.label}`, "success");
        setDeleting(null);
      },
      onError: (error) => show(describeError(error), "error"),
    });
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Connections</h1>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setEditing({ mode: "new", source: null })}
        >
          New connection
        </button>
      </header>

      {connections.isPending && <span className="loading loading-spinner" />}

      {connections.isError && (
        <div role="alert" className="alert alert-error">
          <span>{describeError(connections.error)}</span>
        </div>
      )}

      {connections.data?.length === 0 && (
        <p className="opacity-60">No connections yet. Create one to get started.</p>
      )}

      {connections.data && connections.data.length > 0 && (
        <ConnectionList
          connections={connections.data}
          onEdit={(source) => setEditing({ mode: "edit", source })}
          onDuplicate={(source) => setEditing({ mode: "duplicate", source })}
          onDelete={setDeleting}
        />
      )}

      {editing && (
        <ConnectionFormDialog
          mode={editing.mode}
          source={editing.source}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="text-lg font-semibold">Delete {deleting.label}?</h3>
            <p className="py-4">Its password is removed from the keychain as well.</p>
            <div className="modal-action">
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-error"
                disabled={remove.isPending}
                onClick={() => confirmDelete(deleting)}
              >
                Delete
              </button>
            </div>
          </div>
        </dialog>
      )}
    </main>
  );
}
