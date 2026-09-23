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
      // Where it comes from is worth saying before the reader waits for it: a
      // build is their own toolchain doing it.
      title={`Completion needs ${state.data.server}. ${
        state.data.downloaded
          ? "DataLooker downloads it."
          : "DataLooker builds it with your Go toolchain."
      }`}
      onClick={() =>
        install.mutate(undefined, {
          onError: (error) => show(describeError(error), "error"),
        })
      }
    >
      {install.isPending ? (
        <>
          <span className="loading loading-spinner loading-xs" />
          {state.data.downloaded ? "Downloading" : "Building"} {state.data.server}…
        </>
      ) : (
        `Install ${state.data.server} for completion`
      )}
    </button>
  );
}
