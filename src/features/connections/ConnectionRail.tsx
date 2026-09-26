import { CircleAlert, Keyboard, Plus } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { AgentAccess } from "../agents/AgentAccess";
import { useCommandExits, useRunningCommands } from "../connection-command/hooks";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { DriverIcon } from "./DriverIcon";
import { describeConnection } from "./driver";
import { useConnections, useReorderConnections } from "./hooks";

type Props = {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onShowShortcuts: () => void;
};

/** For moving between connections; what can be done to one is in its header. */
export function ConnectionRail({ selectedId, onSelect, onShowShortcuts }: Props) {
  const connections = useConnections();
  const reorder = useReorderConnections();
  const { show } = useToast();
  const [adding, setAdding] = useState(false);
  // The order shown while a tile is dragged, which becomes the order only if it is dropped.
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);

  const ids = connections.data?.map((connection) => connection.id) ?? [];
  const shown = drag
    ? drag.order.flatMap((id) => connections.data?.find((connection) => connection.id === id) ?? [])
    : connections.data;

  function commit(order: string[]) {
    if (order.some((id, index) => id !== ids[index])) {
      reorder.mutate(order, { onError: (error) => show(describeError(error), "error") });
    }
  }

  // Tiles are all one size, so the one under the pointer after a move is the dragged one.
  function dragOver(event: DragEvent, over: string) {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (over !== drag.id) {
      setDrag({ ...drag, order: moved(drag.order, drag.id, drag.order.indexOf(over)) });
    }
  }

  function keyDown(event: KeyboardEvent, id: string) {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = ids.indexOf(id) + step;
    if (index < 0 || index >= ids.length) return;
    commit(moved(ids, id, index));
  }

  // The rail is always mounted, whichever connection is in front.
  useCommandExits();

  // Wide enough for the window's traffic-light buttons over its top.
  return (
    <nav
      aria-label="Connections"
      className="hairline bg-base-200/60 flex w-24 shrink-0 flex-col items-center border-r"
    >
      <div data-tauri-drag-region className="h-12 w-full shrink-0" />

      <ul
        className="menu min-h-0 w-full flex-1 flex-nowrap gap-1 overflow-y-auto p-2"
        // So a tile let go between two others, or below the last, still lands.
        onDragOver={(event) => {
          if (drag) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!drag) return;
          event.preventDefault();
          commit(drag.order);
          setDrag(null);
        }}
      >
        {connections.isPending &&
          ["one", "two", "three"].map((tile) => (
            // As tall as a tile, so the rail does not shift when they arrive.
            <li key={tile} className="skeleton mx-auto h-19 w-16 rounded-field" />
          ))}

        {connections.isError && (
          <li>
            <button
              type="button"
              className="text-error justify-center"
              aria-label="Retry"
              title={describeError(connections.error)}
              onClick={() => connections.refetch()}
            >
              <CircleAlert className="size-5" />
            </button>
          </li>
        )}

        {shown?.map((connection) => (
          <li
            key={connection.id}
            draggable
            className={drag?.id === connection.id ? "opacity-40" : undefined}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              // WebKit starts no drag that carries nothing.
              event.dataTransfer.setData(DRAGGED, connection.id);
              setDrag({ id: connection.id, order: ids });
            }}
            onDragEnter={(event) => dragOver(event, connection.id)}
            onDragOver={(event) => dragOver(event, connection.id)}
            // After a drop there is nothing left to undo; otherwise the drag was called off.
            onDragEnd={() => setDrag(null)}
            onKeyDown={(event) => keyDown(event, connection.id)}
          >
            <Entry
              connection={connection}
              selected={connection.id === selectedId}
              onSelect={() => onSelect(connection.id)}
            />
          </li>
        ))}

        <li>
          <button
            type="button"
            className="justify-center"
            aria-label="New connection"
            title="New connection"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-5" />
          </button>
        </li>
      </ul>

      <footer className="hairline flex w-full flex-col items-center gap-1 border-t py-2">
        <button
          type="button"
          className="btn btn-ghost btn-square"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (⌘?)"
          aria-keyshortcuts="Meta+Shift+/"
          onClick={onShowShortcuts}
        >
          <Keyboard className="size-5" />
        </button>
        <AgentAccess />
      </footer>

      {adding && <ConnectionFormDialog mode="new" source={null} onClose={() => setAdding(false)} />}
    </nav>
  );
}

/** Its own type, so a tile dropped on the editor is not pasted there as text. */
const DRAGGED = "application/x-datalooker-connection";

/** `ids` with `id` taken out and put back at `index`. */
function moved(ids: string[], id: string, index: number): string[] {
  const rest = ids.filter((other) => other !== id);
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}

type EntryProps = { connection: ConnectionRecord; selected: boolean; onSelect: () => void };

// Most connections have no command to ask about.
function Entry(props: EntryProps) {
  return props.connection.command ? (
    <WatchedEntry {...props} />
  ) : (
    <Avatar {...props} running={false} />
  );
}

/** A tunnel left up is worth seeing from whichever connection is in front. */
function WatchedEntry(props: EntryProps) {
  const running = useRunningCommands().data?.includes(props.connection.id) ?? false;
  return <Avatar {...props} running={running} />;
}

function Avatar({ connection, selected, onSelect, running }: EntryProps & { running: boolean }) {
  return (
    <button
      type="button"
      aria-label={connection.label}
      aria-current={selected ? "true" : undefined}
      title={`${connection.label}\n${describeConnection(connection.config)}`}
      // What moves it up or down the rail, besides dragging.
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      className={`flex flex-col items-center gap-1 px-1 ${selected ? "menu-active" : ""}`}
      onClick={onSelect}
    >
      <div className={`avatar ${running ? "avatar-online" : ""}`}>
        <DriverIcon kind={connection.config.kind} className="size-7" />
      </div>
      {/* Two lines hold most names; the title has the rest. Always two lines tall, so every
          tile is one size, which dragging relies on. */}
      <span className="line-clamp-2 h-[2lh] w-full text-center text-xs wrap-anywhere">
        {connection.label}
      </span>
      {running && (
        <span role="status" className="sr-only">
          Command running
        </span>
      )}
    </button>
  );
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("moved", () => {
    it("puts the one moved where it is asked to go", () => {
      expect(moved(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
      expect(moved(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
      expect(moved(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    });
  });
}
