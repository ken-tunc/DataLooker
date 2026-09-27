import { Ellipsis } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { CommandButton } from "../connection-command/CommandButton";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { DeleteConnectionDialog } from "./DeleteConnectionDialog";
import { describeConnection } from "./driver";
import { DriverIcon } from "./DriverIcon";
import type { FormMode } from "./form";
import { useConnections, useDeleteConnection, useTestConnection } from "./hooks";

type Props = {
  connectionId: string;
  /** Deleting the connection in front leaves nothing in front. */
  onRemoved: (id: string) => void;
};

/** Also where the window is dragged from. */
export function ConnectionHeader({ connectionId, onRemoved }: Props) {
  const { show } = useToast();
  const connection = useConnections().data?.find(({ id }) => id === connectionId);
  const remove = useDeleteConnection();
  const test = useTestConnection();
  const [editing, setEditing] = useState<FormMode | null>(null);
  const [deleting, setDeleting] = useState(false);
  // An anchor name is a dashed ident, which `useId`'s colons are not.
  const menuId = `actions-${useId().replaceAll(":", "")}`;
  const menu = useRef<HTMLUListElement>(null);

  if (!connection) return null;

  /** Choosing an item is done with the menu. */
  function act(choose: (connection: ConnectionRecord) => void) {
    menu.current?.hidePopover();
    if (connection) choose(connection);
  }

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
        className={`flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-3 ${
          connection.production ? "border-error" : "hairline"
        }`}
      >
        <DriverIcon kind={connection.config.kind} />
        <div className="flex min-w-0 grow flex-col leading-tight">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{connection.label}</h1>
            {connection.production && (
              <span className="badge badge-error badge-xs shrink-0">Production</span>
            )}
          </div>
          <span className="text-muted truncate text-xs">
            {describeConnection(connection.config)}
          </span>
        </div>
        {test.isPending && <span className="loading loading-spinner loading-xs shrink-0" />}
        {connection.command && (
          <CommandButton connection={connection} command={connection.command} />
        )}
        <button
          type="button"
          data-tauri-drag-region="false"
          className="btn btn-ghost btn-xs btn-square shrink-0"
          aria-label={`${connection.label} actions`}
          popoverTarget={menuId}
          style={{ anchorName: `--${menuId}` }}
        >
          <Ellipsis className="size-4" />
        </button>
        {/* A popover rather than a disclosure, because the browser closes one
          on a press outside it and on Escape. It lives in the top layer, out
          of the header, so a press on it is not a press on the bar. */}
        <ul
          ref={menu}
          id={menuId}
          popover="auto"
          className="dropdown dropdown-end menu bg-base-200 rounded-box hairline w-40 border p-1 shadow-lg"
          style={{ positionAnchor: `--${menuId}` }}
        >
          <li>
            <button type="button" disabled={test.isPending} onClick={() => act(runTest)}>
              Test
            </button>
          </li>
          <li>
            <button type="button" onClick={() => act(() => setEditing("edit"))}>
              Edit
            </button>
          </li>
          <li>
            <button type="button" onClick={() => act(() => setEditing("duplicate"))}>
              Duplicate
            </button>
          </li>
          <li>
            <button
              type="button"
              className="text-error"
              onClick={() => act(() => setDeleting(true))}
            >
              Delete
            </button>
          </li>
        </ul>
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
