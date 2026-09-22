/**
 * What a SQL tab is called where a language server can see it. A server is
 * told about documents by URI, and the provider that answers for one has only
 * the URI to tell it which connection's server to ask — so the connection is
 * named in the path. The suffix is there because a server may read a document's
 * language from its name.
 */
const ROOT = "file:///datalooker";

export const documentUri = (connectionId: string, tabId: string) =>
  `${ROOT}/${encodeURIComponent(connectionId)}/${encodeURIComponent(tabId)}.sql`;

const OURS = new RegExp(`^${ROOT}/([^/]+)/[^/]+\\.sql$`);

/** Which connection a document belongs to, or nothing for a document that is
 * not one of ours — a definition Monaco colours has a URI of its own. */
export function connectionOf(uri: string): string | null {
  const ours = OURS.exec(uri);
  return ours?.[1] === undefined ? null : decodeURIComponent(ours[1]);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("documentUri", () => {
    it("names the connection a document belongs to", () => {
      const uri = documentUri("c1", "t1");
      expect(uri).toBe("file:///datalooker/c1/t1.sql");
      expect(connectionOf(uri)).toBe("c1");
    });

    it("survives an id that would otherwise change the path", () => {
      const uri = documentUri("a/b", "c?d");
      expect(connectionOf(uri)).toBe("a/b");
    });

    it("claims no document that is not one of ours", () => {
      expect(connectionOf("inmemory://model/1")).toBeNull();
      expect(connectionOf("file:///datalooker/c1/t1.txt")).toBeNull();
      expect(connectionOf("file:///elsewhere/c1/t1.sql")).toBeNull();
    });
  });
}
