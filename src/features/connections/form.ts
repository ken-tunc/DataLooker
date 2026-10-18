import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { SaveConnectionInput } from "../../bindings/SaveConnectionInput";
import type { DriverKind } from "./driver";

export type FormMode = "new" | "edit" | "duplicate";

/** Every driver's fields at once, so switching drivers and back keeps what was typed. */
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
  commandWhileSelected: boolean;
  timeZone: string;
  production: boolean;
};

export type FieldErrors = Partial<Record<keyof ConnectionFormValues, string>>;

/** The fields that must hold something besides spaces. */
type RequiredField = "label" | "host" | "database" | "username" | "project" | "location";

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
  commandWhileSelected: false,
  timeZone: "",
  production: false,
};

export type ParseResult =
  | { ok: true; input: SaveConnectionInput }
  | { ok: false; errors: FieldErrors };

/**
 * A PostgreSQL edit may leave the password blank to keep the stored one,
 * unless it changes the driver, since a BigQuery connection stores none. A new
 * or duplicated one must carry one. BigQuery signs in with the reader's own
 * credentials and sends no secret. Only the picked driver's fields are read.
 */
export function parseConnectionForm(
  values: ConnectionFormValues,
  mode: FormMode,
  source: ConnectionRecord | null,
): ParseResult {
  const errors: FieldErrors = {};
  function required(field: RequiredField, name: string): string {
    const value = values[field].trim();
    if (value === "") errors[field] = `${name} is required`;
    return value;
  }

  const label = required("label", "Label");
  let config: SaveConnectionInput["config"];
  let secret: string | null = null;
  if (values.kind === "postgres") {
    const port = readPort(values.port);
    if (typeof port === "string") errors.port = port;
    const stored = mode === "edit" && source?.config.kind === "postgres";
    if (values.secret !== "") secret = values.secret;
    else if (!stored) errors.secret = "Password is required";
    config = {
      kind: "postgres",
      host: required("host", "Host"),
      port: typeof port === "number" ? port : 0,
      database: required("database", "Database"),
      username: required("username", "Username"),
    };
  } else {
    config = {
      kind: "bigquery",
      project_id: required("project", "Project"),
      location: required("location", "Location"),
    };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Unchecked: the shell is what reads it.
  const command = values.command.trim();
  return {
    ok: true,
    input: {
      id: mode === "edit" ? (source?.id ?? null) : null,
      label,
      config,
      secret,
      command: command === "" ? null : command,
      command_while_selected: values.commandWhileSelected,
      // Picked from the zones the webview knows, or blank for UTC.
      time_zone: values.timeZone === "" ? null : values.timeZone,
      production: values.production,
    },
  };
}

/** The port, or what is wrong with it. */
function readPort(text: string): number | string {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return "Port must be a whole number";
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : "Port must be between 1 and 65535";
}

export function formValuesFrom(record: ConnectionRecord, mode: FormMode): ConnectionFormValues {
  const config = record.config;
  return {
    ...EMPTY_FORM,
    label: mode === "duplicate" ? `${record.label} copy` : record.label,
    kind: config.kind,
    command: record.command ?? "",
    commandWhileSelected: record.command_while_selected,
    // UTC is the blank choice, however it was stored.
    timeZone: record.time_zone === "UTC" ? "" : (record.time_zone ?? ""),
    // A copy of production is production until the reader says otherwise.
    production: record.production,
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
    command_while_selected: true,
    time_zone: "Asia/Tokyo",
    production: true,
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
          command_while_selected: false,
          time_zone: null,
          production: false,
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

    it("sends no secret for BigQuery, even one typed before switching to it", () => {
      const result = parseConnectionForm({ ...bq, secret: "hunter2" }, "new", null);
      expect(result.ok && result.input.secret).toBeNull();
    });

    it("reads only the driver that was picked", () => {
      // The PostgreSQL fields are empty here, and say nothing about a
      // connection that is not one.
      const result = parseConnectionForm({ ...bq, host: "", database: "" }, "new", null);
      expect(result.ok).toBe(true);

      const other = parseConnectionForm({ ...valid, project: "", location: "" }, "new", null);
      expect(other.ok).toBe(true);
    });

    it("asks a new PostgreSQL connection for its password", () => {
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

    it("asks for a password when an edit makes a BigQuery connection PostgreSQL", () => {
      // A BigQuery connection has no password stored to keep.
      const warehouse: ConnectionRecord = {
        ...record,
        config: { kind: "bigquery", project_id: "looking", location: "US" },
      };
      const result = parseConnectionForm({ ...valid, secret: "" }, "edit", warehouse);
      expect(!result.ok && result.errors.secret).toBe("Password is required");
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
        commandWhileSelected: true,
        timeZone: "Asia/Tokyo",
        production: true,
      });
      expect(formValuesFrom(record, "edit").label).toBe("Local");
    });

    it("shows a stored UTC as the blank choice it is", () => {
      expect(formValuesFrom({ ...record, time_zone: "UTC" }, "edit").timeZone).toBe("");
    });

    it("fills the fields of whichever driver the connection is", () => {
      const warehouse = formValuesFrom(
        {
          ...record,
          config: { kind: "bigquery", project_id: "looking", location: "EU" },
          command: null,
          time_zone: null,
          production: false,
        },
        "edit",
      );
      expect(warehouse).toMatchObject({ kind: "bigquery", project: "looking", location: "EU" });
      // The other driver's fields are left where a new connection starts.
      expect(warehouse.host).toBe(EMPTY_FORM.host);
    });
  });
}
