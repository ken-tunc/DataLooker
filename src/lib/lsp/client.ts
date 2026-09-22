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
  /** A document's text as it now stands, whether or not it is new. */
  wrote: (uri: string, text: string) => void;
  closed: (uri: string) => void;
  completions: (uri: string, at: Position) => Promise<CompletionItem[]>;
};

/**
 * How long to wait for an answer before doing without it. A suggestion that
 * arrives after the reader has typed on is about text that has changed, and a
 * request with no answer at all would leave the editor waiting for one.
 */
const ANSWER_MS = 5_000;

/** What the protocol calls a request for a method the receiver does not have. */
const NO_SUCH_METHOD = -32601;

const clients = new Map<string, LanguageClient>();

/**
 * The client for a connection, made when it is first asked for. One per
 * connection, because one server per connection is what the backend runs, and
 * every SQL tab of that connection is a document the server is told about.
 */
export function languageClientFor(connectionId: string): LanguageClient {
  const known = clients.get(connectionId);
  if (known) return known;
  const client = create(connectionId);
  clients.set(connectionId, client);
  return client;
}

function create(connectionId: string): LanguageClient {
  const documents = new Map<string, number>();
  const waiting = new Map<number, (result: unknown) => void>();
  let nextId = 1;
  /** Whether the server is there, asked once: a machine with none installed
   * would otherwise be asked again on every keystroke. */
  let started: Promise<boolean> | null = null;
  let gone = false;
  /** One message at a time. Each is a separate call, and two in flight could
   * reach the server in either order — a change before the open that made the
   * document, or two changes the wrong way round. */
  let queue: Promise<unknown> = Promise.resolve();

  // Listening before the server is asked for. It is a subscription this cannot
  // await, and what makes that safe is that a language server says nothing
  // until it is asked something.
  const listeners = [
    subscribe("lsp:message", (message) => {
      if (message.connection_id === connectionId) received(message);
    }),
    subscribe("lsp:exit", (exit) => {
      if (exit.connection_id === connectionId) ended();
    }),
  ];

  function received({ payload }: LspMessage) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }

    // A server asking the editor something. Nothing here answers one, and a
    // request nobody answers is a server waiting, so it is refused.
    if (typeof message.method === "string" && message.id !== undefined) {
      void send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: NO_SUCH_METHOD, message: `${message.method} is not answered here` },
      });
      return;
    }
    if (typeof message.id !== "number") return;

    const answer = waiting.get(message.id);
    waiting.delete(message.id);
    // An error is an answer: there is nothing to show for it, and the reader
    // asked for a suggestion rather than for news about the server.
    answer?.(message.error === undefined ? message.result : null);
  }

  /** A server that is gone answers nothing, and the next ask starts a new one. */
  function ended() {
    gone = true;
    for (const answer of waiting.values()) answer(null);
    waiting.clear();
    documents.clear();
    for (const stop of listeners) stop();
    if (clients.get(connectionId) === client) clients.delete(connectionId);
  }

  function ready(): Promise<boolean> {
    started ??= startLanguageServer(connectionId).then(
      () => true,
      // No server, or none for this driver. There is no completion then, which
      // is the whole of what it means here.
      () => false,
    );
    return started;
  }

  function send(message: unknown): Promise<boolean> {
    const sent = queue.then(async () => {
      if (gone || !(await ready())) return false;
      return sendToLanguageServer(connectionId, JSON.stringify(message)).then(
        () => true,
        () => false,
      );
    });
    queue = sent;
    return sent;
  }

  const client: LanguageClient = {
    wrote(uri, text) {
      const version = (documents.get(uri) ?? 0) + 1;
      const opening = version === 1;
      documents.set(uri, version);
      void send(
        opening
          ? {
              jsonrpc: "2.0",
              method: "textDocument/didOpen",
              params: { textDocument: { uri, languageId: "sql", version, text } },
            }
          : {
              jsonrpc: "2.0",
              method: "textDocument/didChange",
              // The whole text every time: what the server said it wanted is
              // full synchronization, which is also the only kind that cannot
              // drift from what the editor holds.
              params: { textDocument: { uri, version }, contentChanges: [{ text }] },
            },
      );
    },

    closed(uri) {
      if (!documents.delete(uri)) return;
      void send({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      });
    },

    async completions(uri, at) {
      const id = nextId++;
      const answered = new Promise<unknown>((resolve) => {
        waiting.set(id, resolve);
        setTimeout(() => {
          if (waiting.delete(id)) resolve(null);
        }, ANSWER_MS);
      });

      const sent = await send({
        jsonrpc: "2.0",
        id,
        method: "textDocument/completion",
        params: { textDocument: { uri }, position: at },
      });
      if (!sent) {
        waiting.delete(id);
        return [];
      }
      return itemsOf(await answered);
    },
  };

  return client;
}

/**
 * The items out of a completion answer. The protocol allows either a list of
 * them or an object holding one, and says nothing about which a server sends.
 */
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
