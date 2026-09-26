import { useEffect, useId, useRef, useState } from "react";
import type { QueryTemplate } from "../../bindings/QueryTemplate";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { oneLine } from "../query-history/history";
import { useDeleteTemplate, useTemplates } from "./hooks";
import { TemplateFormDialog } from "./TemplateFormDialog";

/** What the form is open for: a new template, or the one being edited. */
type Editing = { template: QueryTemplate | null } | null;

export function TemplatesDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const templates = useTemplates();
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <>
      <dialog
        ref={dialog}
        className="modal backdrop-blur-sm"
        aria-labelledby={heading}
        onClose={onClose}
      >
        <div className="modal-box flex max-h-[80vh] w-11/12 max-w-2xl flex-col">
          <div className="flex items-center gap-2">
            <h3 id={heading} className="text-lg font-semibold">
              Templates
            </h3>
            <span className="grow" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEditing({ template: null })}
            >
              New template
            </button>
          </div>

          <div className="mt-3 min-h-0 overflow-y-auto">
            {templates.isPending ? (
              <p className="text-faint text-sm">Reading the templates…</p>
            ) : templates.isError ? (
              <div role="alert" className="alert alert-soft alert-error text-sm">
                <span>{describeError(templates.error)}</span>
              </div>
            ) : templates.data.length === 0 ? (
              <p className="text-faint text-sm">No templates yet.</p>
            ) : (
              <ul className="list">
                {templates.data.map((template) => (
                  <Row
                    key={template.id}
                    template={template}
                    onEdit={() => setEditing({ template })}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="submit">Close</button>
        </form>
      </dialog>

      {/* Beside the list, not in it: React hands a dialog's close to the
          dialogs around it, and the form closing would close the list too. */}
      {editing && (
        <TemplateFormDialog template={editing.template} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function Row({ template, onEdit }: { template: QueryTemplate; onEdit: () => void }) {
  const { show } = useToast();
  const remove = useDeleteTemplate();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="list-row items-center py-2">
      <div className="list-col-grow min-w-0">
        <div className="truncate">{template.name}</div>
        <div className="text-faint truncate font-mono text-xs">{oneLine(template.sql)}</div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-1">
          <span className="text-sm">Delete {template.name}?</span>
          <button
            type="button"
            className="btn btn-error btn-xs"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(template.id, {
                onError: (error) => {
                  show(describeError(error), "error");
                  setConfirming(false);
                },
              })
            }
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setConfirming(false)}
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="flex gap-1">
          <button type="button" className="btn btn-ghost btn-xs" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs text-error"
            aria-label={`Delete ${template.name}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
