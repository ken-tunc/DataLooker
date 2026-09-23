/**
 * What a SQL tab is called where a language server can see it. A server is
 * told about documents by URI, and each tab of each connection is a document
 * of its own. The suffix is there because a server may read a document's
 * language from its name.
 */
const ROOT = "file:///datalooker";

export const documentUri = (connectionId: string, tabId: string) =>
  `${ROOT}/${encodeURIComponent(connectionId)}/${encodeURIComponent(tabId)}.sql`;

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("documentUri", () => {
    it("names the connection and the tab a document belongs to", () => {
      expect(documentUri("c1", "t1")).toBe("file:///datalooker/c1/t1.sql");
    });

    it("survives an id that would otherwise change the path", () => {
      expect(documentUri("a/b", "c?d")).toBe("file:///datalooker/a%2Fb/c%3Fd.sql");
    });
  });
}
