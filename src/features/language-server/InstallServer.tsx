import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { useInstallLanguageServer, useLanguageServerState } from "./hooks";

/**
 * Offers to build the language server a connection would be completed
 * against, and says nothing at all where there is one. It is in the editor's
 * own footer because that is where a reader is when they notice that nothing
 * is being suggested.
 */
export function InstallServer({ connectionId }: { connectionId: string }) {
  const { show } = useToast();
  const state = useLanguageServerState(connectionId);
  const install = useInstallLanguageServer(connectionId);

  // A server the reader named themselves and is not there is theirs to put
  // right: building one would not be used, since the name is read first.
  if (state.data?.kind === "named") {
    return <span className="text-warning truncate text-xs">{state.data.message}</span>;
  }
  if (state.data?.kind !== "missing") return null;

  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      disabled={install.isPending}
      // The build is the reader's toolchain doing it, which is worth saying
      // before they wait a minute for it.
      title={`Completion needs ${state.data.server}. DataLooker builds it with your Go toolchain.`}
      onClick={() =>
        install.mutate(undefined, {
          onError: (error) => show(describeError(error), "error"),
        })
      }
    >
      {install.isPending ? (
        <>
          <span className="loading loading-spinner loading-xs" />
          Building {state.data.server}…
        </>
      ) : (
        `Install ${state.data.server} for completion`
      )}
    </button>
  );
}
