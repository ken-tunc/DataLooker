import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { DRIVER_LABELS, type DriverKind } from "./driver";
import { DriverIcon } from "./DriverIcon";
import {
  EMPTY_FORM,
  type ConnectionFormValues,
  type FieldErrors,
  type FormMode,
  formValuesFrom,
  parseConnectionForm,
  SECRET_LABELS,
} from "./form";
import { useSaveConnection } from "./hooks";

/**
 * Every zone the webview can show a point in, which leaves out `UTC` itself:
 * that is the blank choice, since it is what a connection shows unless told.
 */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

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

  function update<F extends keyof ConnectionFormValues>(field: F, value: ConnectionFormValues[F]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseConnectionForm(values, mode, source);
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
      className="modal backdrop-blur-sm"
      onClose={onClose}
      // Escape and the backdrop would unmount the dialog mid-save, and the
      // mutation's callbacks go with it — no toast, no refreshed list.
      onCancel={(event) => {
        if (save.isPending) event.preventDefault();
      }}
    >
      {/* Wider than a modal's own width: a command is a line of shell, and
          reading one wrapped across a narrow box is reading it twice. */}
      <div className="modal-box w-11/12 max-w-2xl">
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

            <Field id={`${fieldId}-kind`} label="Driver">
              {/* An option can hold only text in WebKit, so the mark sits
                  beside the select and follows what it has chosen. A div
                  rather than daisyUI's label, which would name the select
                  a second time. */}
              <div className="select w-full">
                {/* daisyUI pulls the select a field's padding to its left, over
                    whatever sits beside it, so the mark keeps that much clear. */}
                <DriverIcon kind={values.kind} className="me-3 size-6" />
                <select
                  id={`${fieldId}-kind`}
                  value={values.kind}
                  onChange={(event) => update("kind", event.target.value as DriverKind)}
                >
                  {Object.entries(DRIVER_LABELS).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </Field>

            {values.kind === "postgres" ? (
              <>
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
              </>
            ) : (
              <>
                <Field id={`${fieldId}-project`} label="Project" error={errors.project}>
                  <input
                    id={`${fieldId}-project`}
                    className={inputClass(errors.project)}
                    value={values.project}
                    onChange={(event) => update("project", event.target.value)}
                  />
                </Field>

                <Field
                  id={`${fieldId}-location`}
                  label="Location"
                  error={errors.location}
                  hint="Where the jobs run and where the catalog is read: US, EU, asia-northeast1."
                >
                  <input
                    id={`${fieldId}-location`}
                    className={inputClass(errors.location)}
                    value={values.location}
                    onChange={(event) => update("location", event.target.value)}
                  />
                </Field>
              </>
            )}

            <Field
              id={`${fieldId}-secret`}
              label={SECRET_LABELS[values.kind]}
              error={errors.secret}
              // What is stored belongs to the driver it was stored for, so
              // changing the driver asks for the new one's secret.
              hint={
                mode === "edit" && values.kind === source?.config.kind
                  ? `Leave blank to keep the stored ${SECRET_LABELS[values.kind].toLowerCase()}.`
                  : undefined
              }
            >
              {values.kind === "postgres" ? (
                <input
                  id={`${fieldId}-secret`}
                  className={inputClass(errors.secret)}
                  type="password"
                  value={values.secret}
                  onChange={(event) => update("secret", event.target.value)}
                />
              ) : (
                <textarea
                  id={`${fieldId}-secret`}
                  className={`${errors.secret ? "textarea textarea-error" : "textarea"} h-28 w-full font-mono text-xs`}
                  spellCheck={false}
                  placeholder="The service account key, as the JSON file holds it"
                  value={values.secret}
                  onChange={(event) => update("secret", event.target.value)}
                />
              )}
            </Field>

            <Field
              id={`${fieldId}-command`}
              label="Command"
              error={errors.command}
              hint="Run before connecting, from the connection's header: a port forward or an SSH tunnel. Optional."
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

            <Field
              id={`${fieldId}-time-zone`}
              label="Time zone"
              hint="Points in time, such as timestamptz, are shown in this zone. The value is the same whichever zone reads it."
            >
              <select
                id={`${fieldId}-time-zone`}
                className="select w-full"
                value={values.timeZone}
                onChange={(event) => update("timeZone", event.target.value)}
              >
                <option value="">UTC</option>
                {/* One stored under a name this webview no longer lists stays
                    chosen rather than falling back to UTC unseen. */}
                {values.timeZone !== "" && !TIME_ZONES.includes(values.timeZone) && (
                  <option value={values.timeZone}>{values.timeZone}</option>
                )}
                {TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
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
