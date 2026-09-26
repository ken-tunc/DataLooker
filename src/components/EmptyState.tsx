import type { ReactNode } from "react";

/** Holds the place of a result that is not there yet, at the size the result would take. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="hairline text-base-content/50 flex h-full items-center justify-center rounded-box border border-dashed text-sm">
      {children}
    </div>
  );
}
