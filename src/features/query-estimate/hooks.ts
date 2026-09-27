import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { estimateQuery } from "../../lib/commands";

/** Long enough that a burst of typing is dry-run once, short enough to feel live. */
const SETTLE_MS = 400;

export const estimateKeys = {
  all: ["estimate"] as const,
  of: (connectionId: string, sql: string) => [...estimateKeys.all, connectionId, sql] as const,
};

/**
 * The statement is keyed by its text, so an unchanged one is not asked again,
 * and an answer to one the reader has since typed past is not shown. It is not
 * cancelled: a dry run is free, and already on its way.
 */
export function useEstimate(connectionId: string, sql: string) {
  const [settled, setSettled] = useState(sql);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(sql), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [sql]);

  return useQuery({
    enabled: settled.trim() !== "",
    queryKey: estimateKeys.of(connectionId, settled),
    queryFn: () => estimateQuery(connectionId, settled),
    // Keep the last answer on screen until the next one arrives.
    placeholderData: keepPreviousData,
  });
}
