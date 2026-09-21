import { z } from "zod";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { SaveConnectionInput } from "../../bindings/SaveConnectionInput";

export type FormMode = "new" | "edit" | "duplicate";

const required = (field: string) => z.string().trim().min(1, `${field} is required`);

const PORT_RANGE = "Port must be between 1 and 65535";

const schema = z.object({
  label: required("Label"),
  host: required("Host"),
  // Every field holds what the input element holds — a string — so the form's
  // own type can be read off the schema's input side.
  port: z
    .string()
    .trim()
    .regex(/^\d+$/, "Port must be a whole number")
    .transform(Number)
    .refine((port) => port >= 1 && port <= 65535, PORT_RANGE),
  database: required("Database"),
  username: required("Username"),
  password: z.string(),
  // What the reader runs before connecting, if anything: a port forward, an
  // SSH tunnel. Nothing checks what it says — it is a shell command, and the
  // shell is what reads it.
  command: z.string().trim(),
});

export type ConnectionFormValues = z.input<typeof schema>;

export type FieldErrors = Partial<Record<keyof ConnectionFormValues, string>>;

export const EMPTY_FORM: ConnectionFormValues = {
  label: "",
  host: "localhost",
  port: "5432",
  database: "",
  username: "",
  password: "",
  command: "",
};

export type ParseResult =
  | { ok: true; input: SaveConnectionInput }
  | { ok: false; errors: FieldErrors };

/**
 * An edit may leave the password blank, which means "keep the stored one"; a
 * new or duplicated connection has nothing stored yet, so it must carry one.
 */
export function parseConnectionForm(
  values: ConnectionFormValues,
  mode: FormMode,
  sourceId: string | null,
): ParseResult {
  const parsed = schema.safeParse(values);
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof ConnectionFormValues | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
  }
  if (mode !== "edit" && values.password === "") {
    errors.password = "Password is required";
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };

  return {
    ok: true,
    input: {
      id: mode === "edit" ? sourceId : null,
      label: parsed.data.label,
      config: {
        kind: "postgres",
        host: parsed.data.host,
        port: parsed.data.port,
        database: parsed.data.database,
        username: parsed.data.username,
      },
      secret: values.password === "" ? null : values.password,
      command: parsed.data.command === "" ? null : parsed.data.command,
    },
  };
}

export function formValuesFrom(record: ConnectionRecord, mode: FormMode): ConnectionFormValues {
  return {
    label: mode === "duplicate" ? `${record.label} copy` : record.label,
    host: record.config.host,
    port: String(record.config.port),
    database: record.config.database,
    username: record.config.username,
    password: "",
    command: record.command ?? "",
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const valid: ConnectionFormValues = {
    label: "Local",
    host: "localhost",
    port: "5432",
    database: "datalooker",
    username: "admin",
    password: "hunter2",
    command: "",
  };

  describe("parseConnectionForm", () => {
    it("builds the command input, trimming and parsing the port", () => {
      const result = parseConnectionForm({ ...valid, label: "  Local  " }, "new", null);
      expect(result).toEqual({
        ok: true,
        input: {
          id: null,
          label: "Local",
          config: {
            kind: "postgres",
            host: "localhost",
            port: 5432,
            database: "datalooker",
            username: "admin",
          },
          secret: "hunter2",
          command: null,
        },
      });
    });

    it("keeps the id when editing, and drops it when duplicating", () => {
      const edit = parseConnectionForm(valid, "edit", "id-1");
      const duplicate = parseConnectionForm(valid, "duplicate", "id-1");
      expect(edit.ok && edit.input.id).toBe("id-1");
      expect(duplicate.ok && duplicate.input.id).toBeNull();
    });

    it("sends no secret when an edit leaves the password blank", () => {
      const result = parseConnectionForm({ ...valid, password: "" }, "edit", "id-1");
      expect(result.ok && result.input.secret).toBeNull();
    });

    it("requires a password for anything but an edit", () => {
      for (const mode of ["new", "duplicate"] as const) {
        const result = parseConnectionForm({ ...valid, password: "" }, mode, "id-1");
        expect(result.ok).toBe(false);
        expect(!result.ok && result.errors.password).toBe("Password is required");
      }
    });

    it("reports one message per blank field", () => {
      const result = parseConnectionForm({ ...valid, label: "  ", database: "" }, "new", null);
      expect(!result.ok && result.errors).toEqual({
        label: "Label is required",
        database: "Database is required",
      });
    });

    it("sends a command of nothing at all as no command", () => {
      const blank = parseConnectionForm({ ...valid, command: "   " }, "new", null);
      const given = parseConnectionForm({ ...valid, command: " ssh -N host " }, "new", null);
      expect(blank.ok && blank.input.command).toBeNull();
      expect(given.ok && given.input.command).toBe("ssh -N host");
    });

    it.each(["0", "70000", "abc", ""])("rejects the port %o", (port) => {
      const result = parseConnectionForm({ ...valid, port }, "new", null);
      expect(!result.ok && result.errors.port).toBeTruthy();
    });
  });

  describe("formValuesFrom", () => {
    const record: ConnectionRecord = {
      id: "id-1",
      label: "Local",
      config: {
        kind: "postgres",
        host: "db.example.com",
        port: 6543,
        database: "datalooker",
        username: "admin",
      },
      command: "ssh -L 5432:db:5432 bastion",
      created_at: "2026-09-20T00:00:00Z",
    };

    it("marks a duplicate in its label and never carries a password over", () => {
      expect(formValuesFrom(record, "duplicate")).toEqual({
        label: "Local copy",
        host: "db.example.com",
        port: "6543",
        database: "datalooker",
        username: "admin",
        password: "",
        command: "ssh -L 5432:db:5432 bastion",
      });
      expect(formValuesFrom(record, "edit").label).toBe("Local");
    });
  });
}
