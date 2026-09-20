import { useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { QueryPanel } from "../query/QueryPanel";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { ConnectionList } from "./ConnectionList";
import { DeleteConnectionDialog } from "./DeleteConnectionDialog";
import type { FormMode } from "./form";
import { useConnections, useDeleteConnection, useTestConnection } from "./hooks";

type Editing = { mode: FormMode; source: ConnectionRecord | null };

export function ConnectionsPage() {
  const { show } = useToast();
  const connections = useConnections();
  const remove = useDeleteConnection();
  const test = useTestConnection();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ConnectionRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = connections.data?.find((c) => c.id === selectedId) ?? null;

  function confirmDelete(connection: ConnectionRecord) {
    remove.mutate(connection.id, {
      onSuccess: () => {
        show(`Deleted ${connection.label}`, "success");
        setDeleting(null);
      },
      onError: (error) => show(describeError(error), "error"),
    });
  }

  function runTest(connection: ConnectionRecord) {
    test.mutate(connection.id, {
      onSuccess: (elapsedMs) => show(`Reached ${connection.label} in ${elapsedMs} ms`, "success"),
      onError: (error) => show(describeError(error), "error"),
    });
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-8">
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

      {connections.isPending && <ConnectionListSkeleton />}

      {connections.isError && (
        <div role="alert" className="alert alert-error">
          <span>{describeError(connections.error)}</span>
          <button type="button" className="btn btn-sm" onClick={() => connections.refetch()}>
            Retry
          </button>
        </div>
      )}

      {connections.data?.length === 0 && (
        <p className="text-base-content/60">No connections yet. Create one to get started.</p>
      )}

      {connections.data && connections.data.length > 0 && (
        <ConnectionList
          connections={connections.data}
          selectedId={selectedId}
          testingId={test.isPending ? (test.variables ?? null) : null}
          onSelect={(connection) => setSelectedId(connection.id)}
          onTest={runTest}
          onEdit={(source) => setEditing({ mode: "edit", source })}
          onDuplicate={(source) => setEditing({ mode: "duplicate", source })}
          onDelete={setDeleting}
        />
      )}

      {selected && <QueryPanel key={selected.id} connection={selected} />}

      {editing && (
        <ConnectionFormDialog
          mode={editing.mode}
          source={editing.source}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <DeleteConnectionDialog
          connection={deleting}
          pending={remove.isPending}
          onConfirm={() => confirmDelete(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </main>
  );
}

function ConnectionListSkeleton() {
  return (
    <ul className="list bg-base-200 rounded-box">
      {["one", "two", "three"].map((row) => (
        <li key={row} className="list-row items-center gap-3">
          <div className="flex grow flex-col gap-2">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton h-3 w-56" />
          </div>
          <div className="skeleton h-8 w-16" />
        </li>
      ))}
    </ul>
  );
}
