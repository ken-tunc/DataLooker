import type { NamedDefinition } from "../../bindings/NamedDefinition";
import { SqlText } from "../../components/SqlText";
import { describeError } from "../../lib/invoke";
import { useTableDefinition } from "./hooks";

type Props = {
  connectionId: string;
  schema: string;
  table: string;
};

/**
 * What the table is, rather than what is in it: the statement that would make
 * it again, and the indexes and triggers that stand beside it.
 */
export function TableStructure({ connectionId, schema, table }: Props) {
  const definition = useTableDefinition(connectionId, schema, table);

  if (definition.isPending) {
    return <p className="text-base-content/60 p-2 text-sm">Reading the definition…</p>;
  }

  if (definition.isError) {
    return (
      <div role="alert" className="alert alert-error">
        <span className="font-mono text-sm">{describeError(definition.error)}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <SqlText>{definition.data.definition}</SqlText>
      <List title="Indexes" items={definition.data.indexes} empty="No index of its own." />
      <List title="Triggers" items={definition.data.triggers} empty="No trigger." />
    </div>
  );
}

function List({ title, items, empty }: { title: string; items: NamedDefinition[]; empty: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base-content/60 text-xs font-medium tracking-wide uppercase">{title}</h2>
      {items.length === 0 ? (
        <p className="text-base-content/40 text-sm">{empty}</p>
      ) : (
        items.map((item) => <SqlText key={item.name}>{`${item.definition};`}</SqlText>)
      )}
    </section>
  );
}
