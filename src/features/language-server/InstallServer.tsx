import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { useInstallLanguageServer, useLanguageServerState } from "./hooks";

/**
 * Offers to build the language server a connection would be completed
 * against, and says nothing at all where there is one — or where no server
 * speaks to that database. It is in the editor's own footer because that is
 * where a reader is when they notice that nothing is being suggested.
 */
export function InstallServer({ connectionId }: { connectionId: string }) {
  const { show } = useToast();
  const state = useLanguageServerState(connectionId);
  const install = useInstallLanguageServer(connectionId);

  if (state.data !== "missing" && !install.isPending) return null;

  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      disabled={install.isPending}
      // The build is the reader's toolchain doing it, which is worth saying
      // before they wait a minute for it.
      title="Completion needs sqls. DataLooker builds it with your Go toolchain."
      onClick={() =>
        install.mutate(undefined, {
          onError: (error) => show(describeError(error), "error"),
        })
      }
    >
      {install.isPending ? (
        <>
          <span className="loading loading-spinner loading-xs" />
          Building sqls…
        </>
      ) : (
        "Install sqls for completion"
      )}
    </button>
  );
}
