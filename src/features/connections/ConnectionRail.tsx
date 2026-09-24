import { CircleAlert, Plus } from "lucide-react";
import { useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { describeError } from "../../lib/invoke";
import { AgentAccess } from "../agents/AgentAccess";
import { useCommandExits, useRunningCommands } from "../connection-command/hooks";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { describeConnection } from "./driver";
import { useConnections } from "./hooks";

type Props = {
  selectedId: string | null;
  onSelect: (id: string) => void;
};

/** For moving between connections; what can be done to one is in its header. */
export function ConnectionRail({ selectedId, onSelect }: Props) {
  const connections = useConnections();
  const [adding, setAdding] = useState(false);

  // The rail is always mounted, whichever connection is in front.
  useCommandExits();

  // Wide enough for the window's traffic-light buttons over its top.
  return (
    <nav
      aria-label="Connections"
      className="hairline bg-base-200/60 flex w-24 shrink-0 flex-col items-center border-r"
    >
      <div data-tauri-drag-region className="h-12 w-full shrink-0" />

      <ul className="menu min-h-0 w-full flex-1 flex-nowrap gap-1 overflow-y-auto p-2">
        {connections.isPending &&
          ["one", "two", "three"].map((tile) => (
            <li key={tile} className="skeleton mx-auto size-9 rounded-field" />
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

        {connections.data?.map((connection) => (
          <li key={connection.id}>
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

      <footer className="hairline flex w-full justify-center border-t py-2">
        <AgentAccess />
      </footer>

      {adding && <ConnectionFormDialog mode="new" source={null} onClose={() => setAdding(false)} />}
    </nav>
  );
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
      className={`justify-center ${selected ? "menu-active" : ""}`}
      onClick={onSelect}
    >
      <div className={`avatar avatar-placeholder ${running ? "avatar-online" : ""}`}>
        <div className="bg-base-content/10 rounded-field w-9">
          <span className="text-xs font-semibold">{initials(connection.label)}</span>
        </div>
      </div>
      {running && (
        <span role="status" className="sr-only">
          Command running
        </span>
      )}
    </button>
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

// So an accent or an emoji is not cut in half.
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
