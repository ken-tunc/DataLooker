import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import {
  runConnectionCommand,
  runningConnectionCommands,
  stopConnectionCommand,
} from "../../lib/commands";
import { subscribe } from "../../lib/events";
import { describeError } from "../../lib/invoke";
import { connectionKeys } from "../connections/keys";
import { commandKeys } from "./keys";

/** Asked rather than assumed: a run may predate this list. */
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
 * For connections whose command runs only while they are selected: moving from
 * one to another stops the one left before starting the one entered, since two
 * tunnels often forward the same local port. Moves wait their turn, so a quick
 * run across the rail does not leave a tunnel up behind it.
 */
export function useCommandsFollowSelection() {
  const queryClient = useQueryClient();
  const run = useRunCommand();
  const stop = useStopCommand();
  const { show } = useToast();
  const queue = useRef(Promise.resolve());

  // Read when the step runs, not when it was queued: the connection may have
  // been edited while an earlier step waited.
  function following(id: string | null): ConnectionRecord | undefined {
    const connections = queryClient.getQueryData<ConnectionRecord[]>(connectionKeys.list());
    const connection = connections?.find((each) => each.id === id);
    return connection?.command && connection.command_while_selected ? connection : undefined;
  }

  return function follow(from: string | null, to: string) {
    if (from === to) return;
    queue.current = queue.current.then(async () => {
      for (const [id, mutation] of [
        [from, stop],
        [to, run],
      ] as const) {
        const connection = following(id);
        if (!connection) continue;
        try {
          await mutation.mutateAsync(connection.id);
        } catch (error) {
          show(`${connection.label}: ${describeError(error)}`, "error");
        }
      }
    });
  };
}

/**
 * An ending nobody asked for is news, and the last thing the command wrote is
 * usually why. Mount this once.
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
