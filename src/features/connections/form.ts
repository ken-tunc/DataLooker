import { z } from "zod";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { SaveConnectionInput } from "../../bindings/SaveConnectionInput";
import type { DriverKind } from "./driver";

export type FormMode = "new" | "edit" | "duplicate";

const required = (field: string) => z.string().trim().min(1, `${field} is required`);

const PORT_RANGE = "Port must be between 1 and 65535";

// Every driver's fields at once, so switching drivers and back keeps what was
// typed.
const shared = {
  label: required("Label"),
  secret: z.string(),
  // Unchecked: the shell is what reads it.
  command: z.string().trim(),
  // Picked from the zones the webview knows, or blank for UTC.
  timeZone: z.string(),
};

const postgres = z.object({
  ...shared,
  kind: z.literal("postgres"),
  host: required("Host"),
  port: z
    .string()
    .trim()
    .regex(/^\d+$/, "Port must be a whole number")
    .transform(Number)
    .refine((port) => port >= 1 && port <= 65535, PORT_RANGE),
  database: required("Database"),
  username: required("Username"),
});

const bigquery = z.object({
  ...shared,
  kind: z.literal("bigquery"),
  project: required("Project"),
  location: required("Location"),
});

export type ConnectionFormValues = {
  label: string;
  kind: DriverKind;
  host: string;
  port: string;
  database: string;
  username: string;
  project: string;
  location: string;
  secret: string;
  command: string;
  timeZone: string;
};

export type FieldErrors = Partial<Record<keyof ConnectionFormValues, string>>;

export const EMPTY_FORM: ConnectionFormValues = {
  label: "",
  kind: "postgres",
  host: "localhost",
  port: "5432",
  database: "",
  username: "",
  project: "",
  // BigQuery's default.
  location: "US",
  secret: "",
  command: "",
  timeZone: "",
};

export const SECRET_LABELS: Record<DriverKind, string> = {
  postgres: "Password",
  bigquery: "Service account key",
};

export type ParseResult =
  | { ok: true; input: SaveConnectionInput }
  | { ok: false; errors: FieldErrors };

/**
 * An edit may leave the secret blank to keep the stored one, unless it changes
 * the driver: a password is not a service account key. A new or duplicated
 * connection must carry one. Only the picked driver's fields are read.
 */
export function parseConnectionForm(
  values: ConnectionFormValues,
  mode: FormMode,
  source: ConnectionRecord | null,
): ParseResult {
  const parsed =
    values.kind === "postgres" ? postgres.safeParse(values) : bigquery.safeParse(values);
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof ConnectionFormValues | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
  }
  const stored = mode === "edit" && values.kind === source?.config.kind;
  if (!stored && values.secret === "") {
    errors.secret = `${SECRET_LABELS[values.kind]} is required`;
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };

  return {
    ok: true,
    input: {
      id: mode === "edit" ? (source?.id ?? null) : null,
      label: parsed.data.label,
      config:
        parsed.data.kind === "postgres"
          ? {
              kind: "postgres",
              host: parsed.data.host,
              port: parsed.data.port,
              database: parsed.data.database,
              username: parsed.data.username,
            }
          : {
              kind: "bigquery",
              project_id: parsed.data.project,
              location: parsed.data.location,
            },
      secret: values.secret === "" ? null : values.secret,
      command: parsed.data.command === "" ? null : parsed.data.command,
      time_zone: parsed.data.timeZone === "" ? null : parsed.data.timeZone,
    },
  };
}

export function formValuesFrom(record: ConnectionRecord, mode: FormMode): ConnectionFormValues {
  const config = record.config;
  return {
    ...EMPTY_FORM,
    label: mode === "duplicate" ? `${record.label} copy` : record.label,
    kind: config.kind,
    command: record.command ?? "",
    timeZone: record.time_zone ?? "",
    ...(config.kind === "postgres"
      ? {
          host: config.host,
          port: String(config.port),
          database: config.database,
          username: config.username,
        }
      : { project: config.project_id, location: config.location }),
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

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
    time_zone: "Asia/Tokyo",
    created_at: "2026-09-20T00:00:00Z",
  };

  const valid: ConnectionFormValues = {
    ...EMPTY_FORM,
    label: "Local",
    database: "datalooker",
    username: "admin",
    secret: "hunter2",
  };

  const bq: ConnectionFormValues = {
    ...EMPTY_FORM,
    kind: "bigquery",
    label: "Warehouse",
    project: "looking",
    location: "asia-northeast1",
    secret: '{"type":"service_account"}',
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
          time_zone: null,
        },
      });
    });

    it("builds a BigQuery connection from the fields that driver has", () => {
      const result = parseConnectionForm(bq, "new", null);
      expect(result.ok && result.input.config).toEqual({
        kind: "bigquery",
        project_id: "looking",
        location: "asia-northeast1",
      });
    });

    it("reads only the driver that was picked", () => {
      // The PostgreSQL fields are empty here, and say nothing about a
      // connection that is not one.
      const result = parseConnectionForm({ ...bq, host: "", database: "" }, "new", null);
      expect(result.ok).toBe(true);

      const other = parseConnectionForm({ ...valid, project: "", location: "" }, "new", null);
      expect(other.ok).toBe(true);
    });

    it("names the secret the way its driver does", () => {
      const missing = parseConnectionForm({ ...bq, secret: "" }, "new", null);
      expect(!missing.ok && missing.errors.secret).toBe("Service account key is required");

      const password = parseConnectionForm({ ...valid, secret: "" }, "new", null);
      expect(!password.ok && password.errors.secret).toBe("Password is required");
    });

    it("keeps the id when editing, and drops it when duplicating", () => {
      const edit = parseConnectionForm(valid, "edit", record);
      const duplicate = parseConnectionForm(valid, "duplicate", record);
      expect(edit.ok && edit.input.id).toBe("id-1");
      expect(duplicate.ok && duplicate.input.id).toBeNull();
    });

    it("sends no secret when an edit leaves it blank", () => {
      const result = parseConnectionForm({ ...valid, secret: "" }, "edit", record);
      expect(result.ok && result.input.secret).toBeNull();
    });

    it("asks for a new secret when an edit changes the driver", () => {
      // What is stored is a password, and this connection now wants a key.
      const result = parseConnectionForm({ ...bq, secret: "" }, "edit", record);
      expect(!result.ok && result.errors.secret).toBe("Service account key is required");
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

    it("sends a zone left at UTC as no zone", () => {
      const utc = parseConnectionForm(valid, "new", null);
      const tokyo = parseConnectionForm({ ...valid, timeZone: "Asia/Tokyo" }, "new", null);
      expect(utc.ok && utc.input.time_zone).toBeNull();
      expect(tokyo.ok && tokyo.input.time_zone).toBe("Asia/Tokyo");
    });

    it.each(["0", "70000", "abc", ""])("rejects the port %o", (port) => {
      const result = parseConnectionForm({ ...valid, port }, "new", null);
      expect(!result.ok && result.errors.port).toBeTruthy();
    });
  });

  describe("formValuesFrom", () => {
    it("marks a duplicate in its label and never carries a secret over", () => {
      expect(formValuesFrom(record, "duplicate")).toEqual({
        ...EMPTY_FORM,
        label: "Local copy",
        host: "db.example.com",
        port: "6543",
        database: "datalooker",
        username: "admin",
        command: "ssh -L 5432:db:5432 bastion",
        timeZone: "Asia/Tokyo",
      });
      expect(formValuesFrom(record, "edit").label).toBe("Local");
    });

    it("fills the fields of whichever driver the connection is", () => {
      const warehouse = formValuesFrom(
        {
          ...record,
          config: { kind: "bigquery", project_id: "looking", location: "EU" },
          command: null,
          time_zone: null,
        },
        "edit",
      );
      expect(warehouse).toMatchObject({ kind: "bigquery", project: "looking", location: "EU" });
      // The other driver's fields are left where a new connection starts.
      expect(warehouse.host).toBe(EMPTY_FORM.host);
    });
  });
}
