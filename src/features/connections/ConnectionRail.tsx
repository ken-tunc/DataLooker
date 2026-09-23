import { CircleAlert, Plus } from "lucide-react";
import { useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { describeError } from "../../lib/invoke";
import { AgentAccess } from "../agents/AgentAccess";
import { useCommandExits, useRunningCommands } from "../connection-command/hooks";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { describeConnection } from "./driver";
import { DriverIcon } from "./DriverIcon";
import { useConnections } from "./hooks";

type Props = {
  selectedId: string | null;
  onSelect: (id: string) => void;
};

/**
 * Every connection as a tile, the way a chat app lists its workspaces: the
 * rail is for moving between them, and what can be done to one is in the
 * header of the column beside it, once it is the one in front.
 */
export function ConnectionRail({ selectedId, onSelect }: Props) {
  const connections = useConnections();
  const [adding, setAdding] = useState(false);

  // A command can end on a connection that is not the one in front, and the
  // rail is the one part of the window that is always there to hear it.
  useCommandExits();

  // Wide enough for the window's own buttons, which sit over its top.
  return (
    <nav
      aria-label="Connections"
      className="hairline bg-base-200/60 flex w-20 shrink-0 flex-col items-center border-r"
    >
      <div data-tauri-drag-region className="h-12 w-full shrink-0" />

      <ul className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto py-2">
        {connections.isPending &&
          ["one", "two", "three"].map((tile) => (
            <li key={tile} className="skeleton size-11 shrink-0 rounded-xl" />
          ))}

        {connections.isError && (
          <li>
            <button
              type="button"
              className="btn btn-error btn-soft btn-square size-11 rounded-xl"
              aria-label="Retry"
              title={describeError(connections.error)}
              onClick={() => connections.refetch()}
            >
              <CircleAlert className="size-5" />
            </button>
          </li>
        )}

        {connections.data?.map((connection) => (
          <li key={connection.id}>
            <Tile
              connection={connection}
              selected={connection.id === selectedId}
              onSelect={() => onSelect(connection.id)}
            />
          </li>
        ))}

        <li>
          <button
            type="button"
            className="btn btn-ghost btn-square hairline size-11 rounded-xl border border-dashed"
            aria-label="New connection"
            title="New connection"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-5" />
          </button>
        </li>
      </ul>

      <footer className="hairline flex w-full justify-center border-t py-2">
        <AgentAccess />
      </footer>

      {adding && <ConnectionFormDialog mode="new" source={null} onClose={() => setAdding(false)} />}
    </nav>
  );
}

function Tile({
  connection,
  selected,
  onSelect,
}: {
  connection: ConnectionRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={connection.label}
      aria-current={selected ? "true" : undefined}
      title={`${connection.label}\n${describeConnection(connection.config)}`}
      className={`bg-neutral text-neutral-content relative flex size-11 hover:brightness-125 cursor-pointer items-center justify-center rounded-xl text-sm font-semibold transition ${
        selected ? "ring-base-content ring-offset-base-200 ring-2 ring-offset-2" : ""
      }`}
      onClick={onSelect}
    >
      {initials(connection.label)}
      <span className="absolute -right-1 -bottom-1">
        <DriverIcon kind={connection.config.kind} className="size-4" />
      </span>
      {connection.command && <RunningMark connectionId={connection.id} />}
    </button>
  );
}

/**
 * Whether the connection's command is up, on the tile, since a tunnel left
 * running is worth seeing from whichever connection is in front.
 */
function RunningMark({ connectionId }: { connectionId: string }) {
  const running = useRunningCommands();
  if (!running.data?.includes(connectionId)) return null;
  return (
    <span
      role="status"
      aria-label="Command running"
      className="status status-success absolute -top-0.5 -right-0.5"
    />
  );
}

/** Two letters to tell tiles apart by: a word's first letter each, or a lone word's first two. */
function initials(label: string): string {
  const words = label
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map(letters);
  const [first = ["?"], second] = words;
  const picked = second ? [first[0], second[0]] : first.slice(0, 2);
  return picked.join("").toUpperCase();
}

// A letter as a reader counts one, so an accent or an emoji is not cut in half.
const segmenter = new Intl.Segmenter();
function letters(word: string): string[] {
  return Array.from(segmenter.segment(word), ({ segment }) => segment);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("initials", () => {
    it("takes the first letter of the first two words", () => {
      expect(initials("local postgres")).toBe("LP");
      expect(initials("staging_db replica")).toBe("SD");
    });

    it("takes the first two letters of a lone word", () => {
      expect(initials("analytics")).toBe("AN");
    });

    it("keeps a letter made of more than one code point whole", () => {
      expect(initials("e\u0301cole")).toBe("E\u0301C");
      expect(initials("👩‍💻 dev")).toBe("👩‍💻D");
    });

    it("has something to show for a name that is all separators", () => {
      expect(initials("--")).toBe("?");
    });
  });
}
