import type { DriverConfig } from "../../bindings/DriverConfig";

export type DriverKind = DriverConfig["kind"];

/** What each driver is called where a reader has to pick one. */
export const DRIVER_LABELS: Record<DriverKind, string> = {
  postgres: "PostgreSQL",
  bigquery: "BigQuery",
};

/** The one line under a connection's name: where it goes, not how it gets in. */
export function describeConnection(config: DriverConfig): string {
  return config.kind === "postgres"
    ? `${config.host}:${config.port}/${config.database}`
    : `${config.project_id} · ${config.location}`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("describeConnection", () => {
    it("says where a PostgreSQL connection goes", () => {
      expect(
        describeConnection({
          kind: "postgres",
          host: "db.example.com",
          port: 6543,
          database: "datalooker",
          username: "admin",
        }),
      ).toBe("db.example.com:6543/datalooker");
    });

    it("says which project, and where it is read", () => {
      expect(describeConnection({ kind: "bigquery", project_id: "looking", location: "US" })).toBe(
        "looking · US",
      );
    });
  });
}
