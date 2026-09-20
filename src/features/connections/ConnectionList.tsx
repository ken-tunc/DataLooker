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

export function ConnectionList({
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
    <ul className="list bg-base-200 rounded-box">
      {connections.map((connection) => (
        <li key={connection.id} className="list-row items-center">
          <button
            type="button"
            className="list-col-grow cursor-pointer text-left"
            aria-pressed={connection.id === selectedId}
            onClick={() => onSelect(connection)}
          >
            <div
              className={connection.id === selectedId ? "text-primary font-medium" : "font-medium"}
            >
              {connection.label}
            </div>
            <div className="text-base-content/60 text-sm">
              {connection.config.username}@{connection.config.host}:{connection.config.port}/
              {connection.config.database}
            </div>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={testingId === connection.id}
            onClick={() => onTest(connection)}
          >
            {testingId === connection.id && <span className="loading loading-spinner loading-xs" />}
            Test
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onEdit(connection)}>
            Edit
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onDuplicate(connection)}>
            Duplicate
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error btn-soft"
            onClick={() => onDelete(connection)}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
