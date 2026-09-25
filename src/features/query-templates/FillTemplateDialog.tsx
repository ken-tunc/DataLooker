import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { QueryTemplate } from "../../bindings/QueryTemplate";
import { SqlText } from "../../components/SqlText";
import type { DriverKind } from "../connections/driver";
import { useDriver } from "../connections/hooks";
import { filledIn, invalid, type Value, type ValueType, variablesIn } from "./variables";

const TYPES: { type: ValueType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "boolean", label: "Boolean" },
  { type: "null", label: "NULL" },
  { type: "raw", label: "SQL" },
];

const BLANK: Value = { type: "text", text: "" };

type Props = {
  connectionId: string;
  template: QueryTemplate;
  /** Handed the statement with every blank filled in. */
  onFill: (sql: string) => void;
  onClose: () => void;
};

/**
 * Asks for each `@name` in the template. What comes out is opened, not run:
 * the reader sees the statement a value made before it reaches the database.
 */
export function FillTemplateDialog({ connectionId, template, onFill, onClose }: Props) {
  const driver = useDriver(connectionId);
  // The palette this is opened from has read the connections already.
  return driver ? (
    <Blanks driver={driver} template={template} onFill={onFill} onClose={onClose} />
  ) : null;
}

function Blanks({
  driver,
  template,
  onFill,
  onClose,
}: Omit<Props, "connectionId"> & { driver: DriverKind }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fieldId = useId();
  const names = variablesIn(template.sql, driver);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [shown, setShown] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const valueOf = (name: string) => values[name] ?? BLANK;
  const errors = Object.fromEntries(names.map((name) => [name, invalid(valueOf(name))]));
  const filled = filledIn(
    template.sql,
    driver,
    Object.fromEntries(names.map((n) => [n, valueOf(n)])),
  );

  function update(name: string, value: Value) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // Errors show once the reader has tried, not while a value is being typed.
    setShown(true);
    if (names.some((name) => errors[name])) return;
    onFill(filled);
    dialog.current?.close();
  }

  return (
    <dialog
      ref={dialog}
      className="modal backdrop-blur-sm"
      aria-labelledby={`${fieldId}-title`}
      onClose={onClose}
    >
      <div className="modal-box w-11/12 max-w-2xl">
        <form onSubmit={handleSubmit}>
          <fieldset className="fieldset">
            <legend id={`${fieldId}-title`} className="fieldset-legend text-lg">
              {template.name}
            </legend>

            {/* The value before its type: the dialog opens on the first value,
                which is what is typed far more often than a type is changed. */}
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
              {names.map((name) => {
                const value = valueOf(name);
                const error = shown ? errors[name] : null;
                const id = `${fieldId}-${name}`;
                return (
                  <div key={name} className="contents">
                    <label htmlFor={id} className="font-mono text-sm">
                      @{name}
                    </label>
                    {value.type === "boolean" ? (
                      <select
                        id={id}
                        className="select select-sm w-full"
                        value={value.text === "false" ? "false" : "true"}
                        onChange={(event) => update(name, { ...value, text: event.target.value })}
                      >
                        <option value="true">TRUE</option>
                        <option value="false">FALSE</option>
                      </select>
                    ) : (
                      <input
                        id={id}
                        className={`input input-sm w-full font-mono ${error ? "input-error" : ""}`}
                        // What was typed is kept, should the reader switch back.
                        disabled={value.type === "null"}
                        value={value.type === "null" ? "NULL" : value.text}
                        aria-invalid={error ? true : undefined}
                        onChange={(event) => update(name, { ...value, text: event.target.value })}
                      />
                    )}
                    <select
                      className="select select-sm w-28"
                      aria-label={`Type of @${name}`}
                      value={value.type}
                      onChange={(event) => {
                        const type = event.target.value as ValueType;
                        update(name, { ...value, type });
                      }}
                    >
                      {TYPES.map((option) => (
                        <option key={option.type} value={option.type}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {error && (
                      <p className="text-error col-start-2 text-xs" role="alert">
                        {error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <SqlText className="mt-3 max-h-48 overflow-y-auto">{filled}</SqlText>
          </fieldset>

          <div className="modal-action">
            <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Open in a new tab
            </button>
          </div>
        </form>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">Close</button>
      </form>
    </dialog>
  );
}
