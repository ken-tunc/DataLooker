import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import {
  EMPTY_FORM,
  type ConnectionFormValues,
  type FieldErrors,
  type FormMode,
  formValuesFrom,
  parseConnectionForm,
} from "./form";
import { useSaveConnection } from "./hooks";

const TITLES: Record<FormMode, string> = {
  new: "New connection",
  edit: "Edit connection",
  duplicate: "Duplicate connection",
};

type Props = {
  mode: FormMode;
  source: ConnectionRecord | null;
  onClose: () => void;
};

export function ConnectionFormDialog({ mode, source, onClose }: Props) {
  const { show } = useToast();
  const save = useSaveConnection();
  const dialog = useRef<HTMLDialogElement>(null);
  const fieldId = useId();
  const [values, setValues] = useState<ConnectionFormValues>(
    source ? formValuesFrom(source, mode) : EMPTY_FORM,
  );
  const [errors, setErrors] = useState<FieldErrors>({});

  // showModal is what puts the dialog in the top layer, giving it the focus
  // trap, the backdrop and Escape-to-close that an open attribute alone lacks.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function update(field: keyof ConnectionFormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseConnectionForm(values, mode, source?.id ?? null);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    save.mutate(parsed.input, {
      onSuccess: () => {
        show(`Saved ${parsed.input.label}`, "success");
        onClose();
      },
      onError: (error) => show(describeError(error), "error"),
    });
  }

  return (
    <dialog
      ref={dialog}
      className="modal"
      onClose={onClose}
      // Escape and the backdrop would unmount the dialog mid-save, and the
      // mutation's callbacks go with it — no toast, no refreshed list.
      onCancel={(event) => {
        if (save.isPending) event.preventDefault();
      }}
    >
      <div className="modal-box">
        <form onSubmit={handleSubmit}>
          <fieldset className="fieldset">
            <legend className="fieldset-legend text-lg">{TITLES[mode]}</legend>

            <Field id={`${fieldId}-label`} label="Label" error={errors.label}>
              <input
                id={`${fieldId}-label`}
                className={inputClass(errors.label)}
                value={values.label}
                onChange={(event) => update("label", event.target.value)}
              />
            </Field>

            <div className="flex gap-3">
              <div className="grow">
                <Field id={`${fieldId}-host`} label="Host" error={errors.host}>
                  <input
                    id={`${fieldId}-host`}
                    className={inputClass(errors.host)}
                    value={values.host}
                    onChange={(event) => update("host", event.target.value)}
                  />
                </Field>
              </div>
              <div className="w-28">
                <Field id={`${fieldId}-port`} label="Port" error={errors.port}>
                  <input
                    id={`${fieldId}-port`}
                    className={inputClass(errors.port)}
                    inputMode="numeric"
                    value={values.port}
                    onChange={(event) => update("port", event.target.value)}
                  />
                </Field>
              </div>
            </div>

            <Field id={`${fieldId}-database`} label="Database" error={errors.database}>
              <input
                id={`${fieldId}-database`}
                className={inputClass(errors.database)}
                value={values.database}
                onChange={(event) => update("database", event.target.value)}
              />
            </Field>

            <Field id={`${fieldId}-username`} label="Username" error={errors.username}>
              <input
                id={`${fieldId}-username`}
                className={inputClass(errors.username)}
                value={values.username}
                onChange={(event) => update("username", event.target.value)}
              />
            </Field>

            <Field
              id={`${fieldId}-password`}
              label="Password"
              error={errors.password}
              hint={mode === "edit" ? "Leave blank to keep the stored password." : undefined}
            >
              <input
                id={`${fieldId}-password`}
                className={inputClass(errors.password)}
                type="password"
                value={values.password}
                onChange={(event) => update("password", event.target.value)}
              />
            </Field>

            <Field
              id={`${fieldId}-command`}
              label="Command"
              error={errors.command}
              hint="Run before connecting, from the connection list: a port forward or an SSH tunnel. Optional."
            >
              <input
                id={`${fieldId}-command`}
                className={`${inputClass(errors.command)} font-mono`}
                spellCheck={false}
                placeholder="ssh -N -L 5432:db.internal:5432 bastion"
                value={values.command}
                onChange={(event) => update("command", event.target.value)}
              />
            </Field>
          </fieldset>

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={save.isPending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
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

function inputClass(error?: string) {
  return error ? "input input-error w-full" : "input w-full";
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="validator-hint text-error visible mt-0">{error}</p>
      ) : (
        hint && <p className="label mt-0">{hint}</p>
      )}
    </>
  );
}
