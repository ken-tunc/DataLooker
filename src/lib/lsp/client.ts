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

/**
 * How long to wait for an answer before doing without it. A suggestion that
 * arrives after the reader has typed on is about text that has changed, and a
 * request with no answer at all would leave the editor waiting for one.
 */
const ANSWER_MS = 5_000;

/** What the protocol calls a request for a method the receiver does not have. */
const NO_SUCH_METHOD = -32601;

/** A JSON-RPC message, which is an object of whatever the method asks for. */
type Message = Record<string, unknown>;

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
  /** Every document of this connection as it now stands, with the version the
   * server that is up has been told about — zero for one it has never heard
   * of. Kept whether or not there is a server: it is what a server is told
   * when one starts. */
  const documents = new Map<string, { text: string; version: number; told: number }>();
  const waiting = new Map<number, (result: unknown) => void>();
  let nextId = 1;
  /** The one attempt to start a server, or nothing before the first ask and
   * after a server has ended. A machine with none installed answers this once
   * and is then left alone: there is no completion, and asking again on every
   * keystroke would only be slower about it. */
  let starting: Promise<boolean> | null = null;
  /** One message at a time. Each is a separate call, and two in flight could
   * reach the server in either order — a change before the open that made the
   * document, or two changes the wrong way round. */
  let queue: Promise<unknown> = Promise.resolve();

  /** Which server is being talked to, so that a message built for the one
   * before it can be dropped rather than sent to its replacement. */
  let generation = 0;

  // Nothing unsubscribes: a client lives as long as the window it was made in,
  // and the connection it belongs to outlives any one server.
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
    // Valid JSON that is not a message: `null` is what a server that has lost
    // its place sends, and reading a field off it would throw where nobody is
    // listening for one.
    if (said === null || typeof said !== "object" || Array.isArray(said)) return;
    const message = said as Message;

    // A server asking the editor something. Nothing here answers one, and a
    // request nobody answers is a server waiting, so it is refused.
    const { method, id } = message;
    if (typeof method === "string" && id !== undefined) {
      // Whoever asked is the only one the answer means anything to: an id is
      // the asking server's, and the next one may be using it for its own.
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
    // An error is an answer: there is nothing to show for it, and the reader
    // asked for a suggestion rather than for news about the server.
    answer?.(message.error === undefined ? message.result : null);
  }

  /**
   * A server that is gone. The client stays — the editors of this connection
   * are holding it — and what it holds is the documents, so the next thing
   * asked of it starts a server and tells that one about them.
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
      // No server installed, or none for this driver. There is no completion
      // then, which is the whole of what it means here.
      () => false,
    );
    return starting;
  }

  function deliver(message: Message): Promise<boolean> {
    return sendToLanguageServer(connectionId, JSON.stringify(message)).then(
      () => true,
      // The server this was for is not there. Its ending may be on its way as
      // an event or may have been missed, and either way what is true now is
      // that the next thing asked for starts a server.
      () => {
        ended();
        return false;
      },
    );
  }

  /**
   * One message, once there is a server and once every message before it has
   * gone. What to send is decided when its turn comes rather than when it is
   * asked for: a server can end while a message is waiting, and what was true
   * of the document then is not what the next server needs to hear. `null` is
   * a message there is no longer anything to say.
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
      // Closed while it waited, or already told to this server in the state it
      // is in — a second message would say the same thing twice.
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
            // The whole text every time: what the server said it wanted is
            // full synchronization, which is also the only kind that cannot
            // drift from what the editor holds.
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
      // Nothing is listening yet, and opening a tab is no reason to start a
      // server: sqls reads the whole schema on its way up, and a reader who
      // asks nothing of it never needed that read. The text is kept, and the
      // server that does start is told about it.
      if (starting !== null) void tell(uri);
    },

    closed(uri) {
      const document = documents.get(uri);
      if (!document) return;
      documents.delete(uri);
      if (document.told === 0) return;
      // Only the server that was told about it has anything to forget, and
      // only while it is still the server.
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
      // What a server is for, and so what starts one.
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

      // Counted from the moment the question left rather than from the moment
      // it was asked: what is being waited for is the server's answer, and a
      // queue ahead of it is not the server being slow.
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

/**
 * Say that a server has been installed for a connection whose one attempt to
 * start one failed. Nothing else would: a client asks once, so that a machine
 * with no server is not asked again on every keystroke, and what changes that
 * is a server appearing.
 */
export function startServerAgain(connectionId: string) {
  clients.get(connectionId)?.startAgain();
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
