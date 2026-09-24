import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { useInstallLanguageServer, useLanguageServerState } from "./hooks";

/** In the editor's footer, where a reader notices that nothing is suggested. */
export function InstallServer({ connectionId }: { connectionId: string }) {
  const { show } = useToast();
  const state = useLanguageServerState(connectionId);
  const install = useInstallLanguageServer(connectionId);

  // Building one would not help: the reader's name is read first.
  if (state.data?.kind === "named") {
    return <span className="text-warning truncate text-xs">{state.data.message}</span>;
  }
  if (state.data?.kind !== "missing") return null;

  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      disabled={install.isPending}
      // Worth saying before the reader waits: a build uses their toolchain.
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
