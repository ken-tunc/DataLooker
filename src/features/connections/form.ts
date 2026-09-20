import { z } from "zod";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { SaveConnectionInput } from "../../bindings/SaveConnectionInput";

export type FormMode = "new" | "edit" | "duplicate";

export type ConnectionFormValues = {
  label: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
};

export type FieldErrors = Partial<Record<keyof ConnectionFormValues, string>>;

export const EMPTY_FORM: ConnectionFormValues = {
  label: "",
  host: "localhost",
  port: "5432",
  database: "",
  username: "",
  password: "",
};

const required = (field: string) => z.string().trim().min(1, `${field} is required`);

const schema = z.object({
  label: required("Label"),
  host: required("Host"),
  port: z.coerce
    .number({ error: "Port must be a number" })
    .int("Port must be a whole number")
    .min(1, "Port must be between 1 and 65535")
    .max(65535, "Port must be between 1 and 65535"),
  database: required("Database"),
  username: required("Username"),
  password: z.string(),
});

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
      });
      expect(formValuesFrom(record, "edit").label).toBe("Local");
    });
  });
}
