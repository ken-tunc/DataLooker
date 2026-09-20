import { type FormEvent, useState } from "react";
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
  const [values, setValues] = useState<ConnectionFormValues>(
    source ? formValuesFrom(source, mode) : EMPTY_FORM,
  );
  const [errors, setErrors] = useState<FieldErrors>({});

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
    <dialog className="modal modal-open">
      <div className="modal-box">
        <h3 className="text-lg font-semibold">{TITLES[mode]}</h3>
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
          <Field label="Label" error={errors.label}>
            <input
              className="input w-full"
              value={values.label}
              onChange={(event) => update("label", event.target.value)}
            />
          </Field>
          <div className="flex gap-3">
            <div className="grow">
              <Field label="Host" error={errors.host}>
                <input
                  className="input w-full"
                  value={values.host}
                  onChange={(event) => update("host", event.target.value)}
                />
              </Field>
            </div>
            <div className="w-28">
              <Field label="Port" error={errors.port}>
                <input
                  className="input w-full"
                  inputMode="numeric"
                  value={values.port}
                  onChange={(event) => update("port", event.target.value)}
                />
              </Field>
            </div>
          </div>
          <Field label="Database" error={errors.database}>
            <input
              className="input w-full"
              value={values.database}
              onChange={(event) => update("database", event.target.value)}
            />
          </Field>
          <Field label="Username" error={errors.username}>
            <input
              className="input w-full"
              value={values.username}
              onChange={(event) => update("username", event.target.value)}
            />
          </Field>
          <Field label="Password" error={errors.password}>
            <input
              className="input w-full"
              type="password"
              placeholder={mode === "edit" ? "Unchanged" : ""}
              value={values.password}
              onChange={(event) => update("password", event.target.value)}
            />
          </Field>

          <div className="modal-action">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              Save
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="form-control w-full">
      <span className="label-text">{label}</span>
      {children}
      {error && <span className="text-error mt-1 text-sm">{error}</span>}
    </label>
  );
}
