import type { LspMessage } from "../../bindings/LspMessage";
import { sendToLanguageServer, startLanguageServer } from "../commands";
import { subscribe } from "../events";

/** What a server offers at a position, as much of one as this editor reads. */
export type CompletionItem = {
  label: string;
  /** The protocol's own numbering, which is not Monaco's. */
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  sortText?: string;
  filterText?: string;
};

/** Where in a document something is asked about, counted from zero. */
export type Position = { line: number; character: number };

export type LanguageClient = {
  /** Ask for a server again, where the one attempt to start one failed. */
  startAgain: () => void;
  /** A document's text as it now stands, whether or not it is new. */
  wrote: (uri: string, text: string) => void;
  closed: (uri: string) => void;
  completions: (uri: string, at: Position) => Promise<CompletionItem[]>;
};

/** Past this, a suggestion would be about text the reader has since changed. */
const ANSWER_MS = 5_000;

/** What the protocol calls a request for a method the receiver does not have. */
const NO_SUCH_METHOD = -32601;

/** A JSON-RPC message, which is an object of whatever the method asks for. */
type Message = Record<string, unknown>;

const clients = new Map<string, LanguageClient>();

/** One per connection, as the backend runs one server per connection. */
export function languageClientFor(connectionId: string): LanguageClient {
  const known = clients.get(connectionId);
  if (known) return known;
  const client = create(connectionId);
  clients.set(connectionId, client);
  return client;
}

function create(connectionId: string): LanguageClient {
  /** Every document of this connection, with the version the current server
   * was told (zero: never). Kept across servers, so the next one can be told. */
  const documents = new Map<string, { text: string; version: number; told: number }>();
  const waiting = new Map<number, (result: unknown) => void>();
  let nextId = 1;
  /** The one attempt to start a server; null before the first ask and after a
   * server ends. A failure is not retried on every keystroke. */
  let starting: Promise<boolean> | null = null;
  /** One message at a time: two calls in flight could reach the server in
   * either order, such as a change before the open that made the document. */
  let queue: Promise<unknown> = Promise.resolve();

  /** So that a message meant for one server is not sent to its replacement. */
  let generation = 0;

  // Never unsubscribed: a client lives as long as the window.
  subscribe("lsp:message", (message) => {
    if (message.connection_id === connectionId) received(message);
  });
  subscribe("lsp:exit", (exit) => {
    if (exit.connection_id === connectionId) ended();
  });

  function received({ payload }: LspMessage) {
    let said: unknown;
    try {
      said = JSON.parse(payload);
    } catch {
      return;
    }
    // Valid JSON need not be a message; a lost server sends `null`.
    if (said === null || typeof said !== "object" || Array.isArray(said)) return;
    const message = said as Message;

    // Nothing here answers a server's request, so refuse it rather than leave
    // the server waiting.
    const { method, id } = message;
    if (typeof method === "string" && id !== undefined) {
      // The id belongs to the server that asked; its replacement may reuse it.
      const its = generation;
      void send(() =>
        its === generation
          ? {
              jsonrpc: "2.0",
              id,
              error: { code: NO_SUCH_METHOD, message: `${method} is not answered here` },
            }
          : null,
      );
      return;
    }
    if (typeof message.id !== "number") return;

    const answer = waiting.get(message.id);
    waiting.delete(message.id);
    // An error just means there is nothing to suggest.
    answer?.(message.error === undefined ? message.result : null);
  }

  /**
   * The editors keep holding this client, so it stays; the next request starts
   * a server and tells it about the documents.
   */
  function ended() {
    if (starting === null) return;
    generation += 1;
    starting = null;
    for (const answer of waiting.values()) answer(null);
    waiting.clear();
    for (const [uri, document] of documents) documents.set(uri, { ...document, told: 0 });
  }

  /** Whether there is a server, starting one if nobody has yet. */
  function ready(): Promise<boolean> {
    starting ??= startLanguageServer(connectionId).then(
      () => true,
      // No server installed: no completion.
      () => false,
    );
    return starting;
  }

  function deliver(message: Message): Promise<boolean> {
    return sendToLanguageServer(connectionId, JSON.stringify(message)).then(
      () => true,
      // The server is gone, whether or not its exit event arrived.
      () => {
        ended();
        return false;
      },
    );
  }

  /**
   * What to send is built when its turn comes, not when it is queued: a server
   * can end while a message waits, and the next one needs to hear something
   * else. `null` means there is nothing left to say.
   */
  function send(build: () => Message | null): Promise<boolean> {
    const sent = queue.then(async () => {
      if (!(await ready())) return false;
      const message = build();
      return message === null ? false : deliver(message);
    });
    queue = sent;
    return sent;
  }

  /** Say how a document stands: that it exists, or that it has changed. */
  function tell(uri: string): Promise<boolean> {
    return send(() => {
      const document = documents.get(uri);
      // Closed while it waited, or this server already knows this version.
      if (!document || document.told === document.version) return null;

      const { text, version, told } = document;
      documents.set(uri, { ...document, told: version });
      return told === 0
        ? {
            jsonrpc: "2.0",
            method: "textDocument/didOpen",
            params: { textDocument: { uri, languageId: "sql", version, text } },
          }
        : {
            jsonrpc: "2.0",
            method: "textDocument/didChange",
            // Full synchronization: what sqls asks for, and it cannot drift.
            params: { textDocument: { uri, version }, contentChanges: [{ text }] },
          };
    });
  }

  const client: LanguageClient = {
    startAgain: ended,

    wrote(uri, text) {
      const known = documents.get(uri);
      documents.set(uri, {
        text,
        version: (known?.version ?? 0) + 1,
        told: known?.told ?? 0,
      });
      // Opening a tab does not start a server: sqls reads the whole schema on
      // start. The server that does start is told about the text.
      if (starting !== null) void tell(uri);
    },

    closed(uri) {
      const document = documents.get(uri);
      if (!document) return;
      documents.delete(uri);
      if (document.told === 0) return;
      // Only the server that was told about it has anything to forget.
      const its = generation;
      void send(() =>
        its === generation
          ? {
              jsonrpc: "2.0",
              method: "textDocument/didClose",
              params: { textDocument: { uri } },
            }
          : null,
      );
    },

    async completions(uri, at) {
      // Completion is what starts a server.
      if (!(await ready())) return [];
      // Every document that is not as the server last heard it, which after a
      // server has ended is all of them.
      for (const [known, document] of documents) {
        if (document.told !== document.version) void tell(known);
      }

      const id = nextId++;
      let answer: (result: unknown) => void = () => {};
      const answered = new Promise<unknown>((resolve) => {
        answer = resolve;
        waiting.set(id, resolve);
      });

      const sent = await send(() => ({
        jsonrpc: "2.0",
        id,
        method: "textDocument/completion",
        params: { textDocument: { uri }, position: at },
      }));
      if (!sent) {
        waiting.delete(id);
        return [];
      }

      // Timed from when the request left: time in the queue is not the server
      // being slow.
      const late = setTimeout(() => {
        if (waiting.delete(id)) answer(null);
      }, ANSWER_MS);
      const result = await answered;
      clearTimeout(late);
      return itemsOf(result);
    },
  };

  return client;
}

/** After a server is installed, allow a client whose one start failed to try again. */
export function startServerAgain(connectionId: string) {
  clients.get(connectionId)?.startAgain();
}

/** The protocol allows either a list of items or an object holding one. */
export function itemsOf(result: unknown): CompletionItem[] {
  if (Array.isArray(result)) return result as CompletionItem[];
  if (result !== null && typeof result === "object") {
    const { items } = result as { items?: unknown };
    if (Array.isArray(items)) return items as CompletionItem[];
  }
  return [];
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("itemsOf", () => {
    it("reads a list of items, and a list inside an object", () => {
      const items = [{ label: "orders" }];
      expect(itemsOf(items)).toEqual(items);
      expect(itemsOf({ isIncomplete: true, items })).toEqual(items);
    });

    it("makes nothing of an answer that holds no items", () => {
      expect(itemsOf(null)).toEqual([]);
      expect(itemsOf(undefined)).toEqual([]);
      expect(itemsOf({ items: "orders" })).toEqual([]);
      expect(itemsOf("orders")).toEqual([]);
    });
  });
}
