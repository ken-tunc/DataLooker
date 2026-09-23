import { ArrowLeftRight, Square } from "lucide-react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { useRunCommand, useRunningCommands, useStopCommand } from "./hooks";

/**
 * Runs and stops the command a connection carries, and shows whether it is up.
 * Whoever renders it decides there is a command to run: most connections have
 * none, and asking what is running on their behalf would be asking for nothing.
 */
export function CommandButton({
  connection,
  command,
}: {
  connection: ConnectionRecord;
  command: string;
}) {
  const { show } = useToast();
  const running = useRunningCommands();
  const run = useRunCommand();
  const stop = useStopCommand();

  const isRunning = running.data?.includes(connection.id) ?? false;
  const pending = run.isPending || stop.isPending;
  const action = isRunning ? "Stop" : "Run";

  function toggle() {
    const mutation = isRunning ? stop : run;
    mutation.mutate(connection.id, {
      onError: (error) => show(`${connection.label}: ${describeError(error)}`, "error"),
    });
  }

  return (
    <button
      type="button"
      className={`btn btn-ghost btn-xs btn-square shrink-0 ${isRunning ? "text-success" : ""}`}
      disabled={pending}
      title={`${action} ${command}`}
      aria-label={`${action} the command for ${connection.label}`}
      onClick={toggle}
    >
      {pending ? (
        <span className="loading loading-spinner loading-xs" />
      ) : isRunning ? (
        <Square className="size-3.5 fill-current" />
      ) : (
        <ArrowLeftRight className="size-4" />
      )}
    </button>
  );
}
