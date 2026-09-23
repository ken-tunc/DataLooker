import { Ellipsis } from "lucide-react";
import { useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { CommandButton } from "../connection-command/CommandButton";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { DeleteConnectionDialog } from "./DeleteConnectionDialog";
import { describeConnection } from "./driver";
import type { FormMode } from "./form";
import { useConnections, useDeleteConnection, useTestConnection } from "./hooks";

type Props = {
  connectionId: string;
  /** Deleting the connection in front leaves nothing in front. */
  onRemoved: (id: string) => void;
};

/**
 * The name of the connection in front, and everything that can be done to it.
 * It is also where the window is dragged from, beside the rail.
 */
export function ConnectionHeader({ connectionId, onRemoved }: Props) {
  const { show } = useToast();
  const connection = useConnections().data?.find(({ id }) => id === connectionId);
  const remove = useDeleteConnection();
  const test = useTestConnection();
  const [editing, setEditing] = useState<FormMode | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!connection) return null;

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
        setDeleting(false);
        onRemoved(connection.id);
      },
      onError: (error) => show(describeError(error), "error"),
    });
  }

  return (
    <>
      <header
        data-tauri-drag-region="deep"
        className="hairline flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-3"
      >
        <div className="flex min-w-0 grow flex-col leading-tight">
          <h1 className="truncate text-sm font-semibold">{connection.label}</h1>
          <span className="text-base-content/60 truncate text-xs">
            {describeConnection(connection.config)}
          </span>
        </div>
        {test.isPending && <span className="loading loading-spinner loading-xs shrink-0" />}
        {connection.command && (
          <CommandButton connection={connection} command={connection.command} />
        )}
        {/* The open menu sits inside the header, and a press on its padding is
          not a press on the bar. */}
        <details data-tauri-drag-region="false" className="dropdown dropdown-end shrink-0">
          <summary
            className="btn btn-ghost btn-xs btn-square"
            aria-label={`${connection.label} actions`}
          >
            <Ellipsis className="size-4" />
          </summary>
          <ul className="dropdown-content menu bg-base-100 rounded-box z-10 w-40 p-2 shadow-sm">
            <li>
              <button type="button" disabled={test.isPending} onClick={() => runTest(connection)}>
                Test
              </button>
            </li>
            <li>
              <button type="button" onClick={() => setEditing("edit")}>
                Edit
              </button>
            </li>
            <li>
              <button type="button" onClick={() => setEditing("duplicate")}>
                Duplicate
              </button>
            </li>
            <li>
              <button type="button" className="text-error" onClick={() => setDeleting(true)}>
                Delete
              </button>
            </li>
          </ul>
        </details>
      </header>

      {editing && (
        <ConnectionFormDialog mode={editing} source={connection} onClose={() => setEditing(null)} />
      )}

      {deleting && (
        <DeleteConnectionDialog
          connection={connection}
          pending={remove.isPending}
          onConfirm={() => confirmDelete(connection)}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}
