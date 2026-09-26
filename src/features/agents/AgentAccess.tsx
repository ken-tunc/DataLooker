import { Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { useAgentAccess, useSetAgentAccess } from "./hooks";

/**
 * Shut until the reader opens it: anything on this machine could ask a port
 * about their databases.
 */
export function AgentAccess() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-square"
        aria-label="Agents"
        title="Agents"
        onClick={() => setOpen(true)}
      >
        <Bot className="size-5" />
      </button>
      {open && <AgentAccessDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function AgentAccessDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { show } = useToast();
  const access = useAgentAccess();
  const set = useSetAgentAccess();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const enabled = access.data?.enabled ?? false;
  const url = access.data ? `http://127.0.0.1:${access.data.port}/mcp` : "";

  function copy(what: string, value: string) {
    void navigator.clipboard
      .writeText(value)
      .then(() => show(`${what} copied`, "success"))
      .catch((error: unknown) => show(describeError(error), "error"));
  }

  return (
    <dialog
      ref={dialog}
      className="modal backdrop-blur-sm"
      aria-labelledby="agents-title"
      onClose={onClose}
    >
      <div className="modal-box">
        <h3 id="agents-title" className="text-lg font-semibold">
          Agents
        </h3>
        <p className="text-muted py-2 text-sm">
          An agent that can reach this app can list your connections and read what they hold. It
          answers on this machine only, and only whoever presents the token.
        </p>

        <label className="flex cursor-pointer items-center gap-2 py-2">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={enabled}
            disabled={access.isPending || set.isPending}
            onChange={(event) =>
              set.mutate(event.target.checked, {
                onError: (error) => show(describeError(error), "error"),
              })
            }
          />
          Answer agents
          {set.isPending && <span className="loading loading-spinner loading-xs" />}
        </label>

        {enabled && access.data && (
          <div className="flex flex-col gap-2 pt-2">
            <Handed what="Address" value={url} onCopy={copy} />
            <Handed what="Token" value={access.data.token} onCopy={copy} secret />
          </div>
        )}

        <div className="modal-action">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">Close</button>
      </form>
    </dialog>
  );
}

/** One thing to hand an agent, shown so it can be read and copied. */
function Handed({
  what,
  value,
  secret = false,
  onCopy,
}: {
  what: string;
  value: string;
  secret?: boolean;
  onCopy: (what: string, value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-sm">{what}</span>
      <input
        className="input input-sm grow font-mono text-xs"
        readOnly
        // Not hidden: it is worth something only on this machine, and the
        // reader has to read it to hand it on.
        value={value}
        aria-label={what}
      />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onCopy(what, value)}
        aria-label={`Copy ${secret ? "the token" : what.toLowerCase()}`}
      >
        Copy
      </button>
    </div>
  );
}
