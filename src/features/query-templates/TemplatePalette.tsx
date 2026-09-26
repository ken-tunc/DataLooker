import type { QueryTemplate } from "../../bindings/QueryTemplate";
import { Palette } from "../../components/Palette";
import { describeError } from "../../lib/invoke";
import { useDriver } from "../connections/hooks";
import { oneLine } from "../query-history/history";
import { useTemplates } from "./hooks";
import { variablesIn } from "./variables";

type Props = {
  connectionId: string;
  /** A template with nothing to fill in opens as it is. */
  onOpenQuery: (title: string, sql: string) => void;
  onFill: (template: QueryTemplate) => void;
  onManage: () => void;
  onClose: () => void;
};

function matching(templates: readonly QueryTemplate[], search: string): QueryTemplate[] {
  const needle = search.trim().toLowerCase();
  return templates.filter(
    (template) =>
      template.name.toLowerCase().includes(needle) || template.sql.toLowerCase().includes(needle),
  );
}

export function TemplatePalette({ connectionId, onOpenQuery, onFill, onManage, onClose }: Props) {
  const templates = useTemplates();
  const driver = useDriver(connectionId);

  function choose(template: QueryTemplate) {
    if (driver && variablesIn(template.sql, driver).length > 0) onFill(template);
    else onOpenQuery(template.name, template.sql);
  }

  return (
    <Palette
      label="Use a template"
      placeholder="Search your templates"
      search={(query) => matching(templates.data ?? [], query)}
      keyOf={(template) => template.id}
      onChoose={choose}
      onClose={onClose}
      empty="No template matches."
      status={
        templates.isPending ? (
          <p className="text-faint p-2 text-sm">Reading the templates…</p>
        ) : templates.isError ? (
          <div role="alert" className="alert alert-soft alert-error text-sm">
            <span className="truncate">{describeError(templates.error)}</span>
          </div>
        ) : templates.data.length === 0 ? (
          <p className="text-faint p-2 text-sm">
            No templates yet. Save a statement as one from its SQL tab.
          </p>
        ) : null
      }
      footer={() => (
        <div className="flex justify-end px-2">
          <button type="button" className="btn btn-ghost btn-xs" onClick={onManage}>
            Manage templates…
          </button>
        </div>
      )}
    >
      {(template) => (
        <>
          <span className="shrink-0">{template.name}</span>
          <span className="text-faint truncate font-mono text-xs">{oneLine(template.sql)}</span>
        </>
      )}
    </Palette>
  );
}
