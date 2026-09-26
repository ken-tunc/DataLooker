import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { QueryTemplate } from "../../bindings/QueryTemplate";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { useSaveTemplate } from "./hooks";

type Props = {
  /** The template being edited, or nothing to make a new one. */
  template: QueryTemplate | null;
  /** What a new template starts with: the statement it is being made from. */
  sql?: string;
  onClose: () => void;
};

export function TemplateFormDialog({ template, sql: initialSql = "", onClose }: Props) {
  const { show } = useToast();
  const save = useSaveTemplate();
  const dialog = useRef<HTMLDialogElement>(null);
  const fieldId = useId();
  const [name, setName] = useState(template?.name ?? "");
  const [sql, setSql] = useState(template?.sql ?? initialSql);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "" || sql.trim() === "") {
      setError("A template needs a name and a statement.");
      return;
    }
    save.mutate(
      { id: template?.id ?? null, name, sql },
      {
        onSuccess: () => {
          show(`Saved ${name.trim()}`, "success");
          dialog.current?.close();
        },
        // Kept in the dialog: a taken name is fixed here, not after a toast fades.
        onError: (failure) => setError(describeError(failure)),
      },
    );
  }

  return (
    <dialog
      ref={dialog}
      className="modal backdrop-blur-sm"
      onClose={onClose}
      // Closing mid-save would take the mutation's callbacks with it.
      onCancel={(event) => {
        if (save.isPending) event.preventDefault();
      }}
    >
      <div className="modal-box w-11/12 max-w-2xl">
        <form onSubmit={handleSubmit}>
          <fieldset className="fieldset">
            <legend className="fieldset-legend text-lg">
              {template ? "Edit template" : "Save as template"}
            </legend>

            <label className="label" htmlFor={`${fieldId}-name`}>
              Name
            </label>
            <input
              id={`${fieldId}-name`}
              className="input input-sm w-full"
              value={name}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />

            <label className="label" htmlFor={`${fieldId}-sql`}>
              SQL
            </label>
            <textarea
              id={`${fieldId}-sql`}
              className="textarea h-48 w-full font-mono text-sm"
              spellCheck={false}
              value={sql}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              onChange={(event) => {
                setSql(event.target.value);
                setError(null);
              }}
            />
            <p className="label mt-0">
              Write <code>@name</code> where a value goes. It is asked for each time the template is
              used.
            </p>

            {error && (
              <div
                id={`${fieldId}-error`}
                role="alert"
                className="alert alert-soft alert-error mt-2 text-sm"
              >
                <span>{error}</span>
              </div>
            )}
          </fieldset>

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={save.isPending}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending}>
              {save.isPending && <span className="loading loading-spinner loading-xs" />}
              Save
            </button>
          </div>
        </form>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={save.isPending}>
          Close
        </button>
      </form>
    </dialog>
  );
}
