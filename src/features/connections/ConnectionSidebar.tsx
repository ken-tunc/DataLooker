import type { ConnectionRecord } from "../../bindings/ConnectionRecord";

type Props = {
  connections: ConnectionRecord[];
  selectedId: string | null;
  testingId: string | null;
  onSelect: (connection: ConnectionRecord) => void;
  onTest: (connection: ConnectionRecord) => void;
  onEdit: (connection: ConnectionRecord) => void;
  onDuplicate: (connection: ConnectionRecord) => void;
  onDelete: (connection: ConnectionRecord) => void;
};

export function ConnectionSidebar({
  connections,
  selectedId,
  testingId,
  onSelect,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
}: Props) {
  return (
    <ul className="menu w-full gap-1 p-2">
      {connections.map((connection) => (
        <li key={connection.id}>
          <div
            className={`flex items-center gap-1 ${connection.id === selectedId ? "menu-active" : ""}`}
          >
            <button
              type="button"
              className="flex min-w-0 grow flex-col items-start gap-0 text-left"
              onClick={() => onSelect(connection)}
            >
              <span className="w-full truncate">{connection.label}</span>
              <span className="w-full truncate text-xs opacity-60">
                {connection.config.host}:{connection.config.port}/{connection.config.database}
              </span>
            </button>
            {testingId === connection.id && (
              <span className="loading loading-spinner loading-xs shrink-0" />
            )}
            <details className="dropdown dropdown-end shrink-0">
              <summary className="btn btn-ghost btn-xs" aria-label={`${connection.label} actions`}>
                ⋯
              </summary>
              <ul className="dropdown-content menu bg-base-100 rounded-box z-10 w-40 p-2 shadow-sm">
                <li>
                  <button type="button" onClick={() => onTest(connection)}>
                    Test
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onEdit(connection)}>
                    Edit
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onDuplicate(connection)}>
                    Duplicate
                  </button>
                </li>
                <li>
                  <button type="button" className="text-error" onClick={() => onDelete(connection)}>
                    Delete
                  </button>
                </li>
              </ul>
            </details>
          </div>
        </li>
      ))}
    </ul>
  );
}
