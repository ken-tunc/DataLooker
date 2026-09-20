import type { ConnectionRecord } from "../../bindings/ConnectionRecord";

type Props = {
  connections: ConnectionRecord[];
  onEdit: (connection: ConnectionRecord) => void;
  onDuplicate: (connection: ConnectionRecord) => void;
  onDelete: (connection: ConnectionRecord) => void;
};

export function ConnectionList({ connections, onEdit, onDuplicate, onDelete }: Props) {
  return (
    <ul className="list bg-base-200 rounded-box">
      {connections.map((connection) => (
        <li key={connection.id} className="list-row items-center">
          <div className="list-col-grow">
            <div className="font-medium">{connection.label}</div>
            <div className="text-base-content/60 text-sm">
              {connection.config.username}@{connection.config.host}:{connection.config.port}/
              {connection.config.database}
            </div>
          </div>
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
