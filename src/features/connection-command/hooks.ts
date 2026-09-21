import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import {
  runConnectionCommand,
  runningConnectionCommands,
  stopConnectionCommand,
} from "../../lib/commands";
import { subscribe } from "../../lib/events";
import { connectionKeys } from "../connections/keys";
import { commandKeys } from "./keys";

/**
 * Which connections have a command up. Asked rather than assumed: a run the
 * window did not start is still a run — one a second window started, or one
 * left over from before this list was mounted.
 */
export function useRunningCommands() {
  return useQuery({ queryKey: commandKeys.running(), queryFn: runningConnectionCommands });
}

export function useRunCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: runConnectionCommand,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: commandKeys.all });
    },
  });
}

export function useStopCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: stopConnectionCommand,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: commandKeys.all });
    },
  });
}

/**
 * Watch for commands ending. A command that was stopped ended because someone
 * said so; anything else is news — the tunnel the reader is querying through
 * has gone, and the last thing it wrote is usually why. Mount this once.
 */
export function useCommandExits() {
  const queryClient = useQueryClient();
  const { show } = useToast();

  useEffect(
    () =>
      subscribe("shell:exit", (exit) => {
        void queryClient.invalidateQueries({ queryKey: commandKeys.all });
        if (exit.stopped || exit.code === 0) return;
        const connections = queryClient.getQueryData<ConnectionRecord[]>(connectionKeys.list());
        const label =
          connections?.find((connection) => connection.id === exit.connection_id)?.label ??
          exit.connection_id;
        show(`${label}: ${describeExit(exit.code)}${lastLine(exit.output)}`, "error");
      }),
    [queryClient, show],
  );
}

function describeExit(code: number | null): string {
  return code === null ? "the command was killed" : `the command exited with ${code}`;
}

function lastLine(output: string): string {
  const last = output.trimEnd().split("\n").at(-1)?.trim();
  return last ? ` — ${last}` : "";
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("what an ending is reported as", () => {
    it("names the code when there was one", () => {
      expect(describeExit(3)).toBe("the command exited with 3");
      expect(describeExit(null)).toBe("the command was killed");
    });

    it("quotes the last thing the command said, and nothing when it said nothing", () => {
      expect(lastLine("listening\nbind: address already in use\n")).toBe(
        " — bind: address already in use",
      );
      expect(lastLine("   ")).toBe("");
      expect(lastLine("")).toBe("");
    });
  });
}
