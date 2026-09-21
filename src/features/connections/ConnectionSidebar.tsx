import { useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { CommandButton } from "../connection-command/CommandButton";
import { describeConnection } from "./driver";
import { useCommandExits } from "../connection-command/hooks";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { DeleteConnectionDialog } from "./DeleteConnectionDialog";
import type { FormMode } from "./form";
import { useConnections, useDeleteConnection, useTestConnection } from "./hooks";

type Editing = { mode: FormMode; source: ConnectionRecord | null };

type Props = {
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The selected connection can be the one that was just deleted. */
  onRemoved: (id: string) => void;
};

export function ConnectionSidebar({ selectedId, onSelect, onRemoved }: Props) {
  const { show } = useToast();
  const connections = useConnections();
  const remove = useDeleteConnection();
  const test = useTestConnection();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ConnectionRecord | null>(null);

  // The list is where a command is started, so it is where its ending belongs.
  useCommandExits();

  function runTest(connection: ConnectionRecord) {
    test.mutate(connection.id, {
      onSuccess: (elapsedMs) => show(`Reached ${connection.label} in ${elapsedMs} ms`, "success"),
      onError: (error) => show(describeError(error), "error"),
    });
  }

  function confirmDelete(connection: ConnectionRecord) {
    remove.mutate(connection.id, {
      onSuccess: () => {
        show(`Deleted ${connection.label}`, "success");
        setDeleting(null);
        onRemoved(connection.id);
      },
      onError: (error) => show(describeError(error), "error"),
    });
  }

  // Wide enough for a label beside the buttons the row carries: a name
  // truncated to make room for them says less than the room is worth.
  return (
    <aside className="border-base-300 bg-base-200 flex w-72 shrink-0 flex-col border-r">
      <header className="flex items-center justify-between p-3">
        <h1 className="font-semibold">Connections</h1>
        <button
          type="button"
          className="btn btn-primary btn-xs"
          onClick={() => setEditing({ mode: "new", source: null })}
        >
          New
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {connections.isPending && <Skeleton />}

        {connections.isError && (
          <div role="alert" className="alert alert-error m-2 text-sm">
            <span>{describeError(connections.error)}</span>
            <button type="button" className="btn btn-xs" onClick={() => connections.refetch()}>
              Retry
            </button>
          </div>
        )}

        {connections.data?.length === 0 && (
          <p className="text-base-content/60 p-3 text-sm">No connections yet.</p>
        )}

        <ul className="menu w-full gap-1 p-2">
          {connections.data?.map((connection) => (
            <li key={connection.id}>
              <div
                className={`flex items-center gap-1 ${
                  connection.id === selectedId ? "menu-active" : ""
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 grow flex-col items-start gap-0 text-left"
                  onClick={() => onSelect(connection.id)}
                >
                  <span className="w-full truncate">{connection.label}</span>
                  <span className="w-full truncate text-xs opacity-60">
                    {describeConnection(connection.config)}
                  </span>
                </button>
                {test.isPending && test.variables === connection.id && (
                  <span className="loading loading-spinner loading-xs shrink-0" />
                )}
                {connection.command && (
                  <CommandButton connection={connection} command={connection.command} />
                )}
                <details className="dropdown dropdown-end shrink-0">
                  <summary
                    className="btn btn-ghost btn-xs"
                    aria-label={`${connection.label} actions`}
                  >
                    ⋯
                  </summary>
                  <ul className="dropdown-content menu bg-base-100 rounded-box z-10 w-40 p-2 shadow-sm">
                    <li>
                      {/* One mutation serves every row, and a second test
                          while one is running would take its callbacks. */}
                      <button
                        type="button"
                        disabled={test.isPending}
                        onClick={() => runTest(connection)}
                      >
                        Test
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        onClick={() => setEditing({ mode: "edit", source: connection })}
                      >
                        Edit
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        onClick={() => setEditing({ mode: "duplicate", source: connection })}
                      >
                        Duplicate
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        className="text-error"
                        onClick={() => setDeleting(connection)}
                      >
                        Delete
                      </button>
                    </li>
                  </ul>
                </details>
              </div>
            </li>
          ))}
        </ul>
      </div>

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
    </aside>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {["one", "two", "three"].map((row) => (
        <div key={row} className="skeleton h-9 w-full" />
      ))}
    </div>
  );
}
