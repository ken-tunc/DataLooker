import { useEffect, useId, useRef } from "react";
import type { Hazard } from "../../bindings/Hazard";
import type { Risk } from "../../bindings/Risk";
import { SqlText } from "../../components/SqlText";

type Props = {
  risks: Risk[];
  onRun: () => void;
  onClose: () => void;
};

/** Cancel holds the focus, so a second ⌘Enter or Enter does not run it. */
export function RiskDialog({ risks, onRun, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal backdrop-blur-sm"
      aria-labelledby={heading}
      onClose={onClose}
    >
      <div className="modal-box max-w-2xl">
        <h3 id={heading} className="text-lg font-semibold">
          Run {risks.length === 1 ? "this statement" : "these statements"}?
        </h3>
        <ul className="flex max-h-96 flex-col gap-3 overflow-y-auto py-4">
          {byStatement(risks).map(([statement, hazards]) => (
            <li key={statement} className="flex flex-col gap-1">
              {hazards.map((risk) => (
                <p key={`${risk.hazard} ${risk.targets.join()}`} className="text-sm">
                  {sentence(risk)}
                </p>
              ))}
              <SqlText className="max-h-32">{statement}</SqlText>
            </li>
          ))}
        </ul>
        <div className="modal-action">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error"
            onClick={() => {
              onRun();
              dialog.current?.close();
            }}
          >
            Run
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">Close</button>
      </form>
    </dialog>
  );
}

/** A statement with two hazards is shown once. */
function byStatement(risks: Risk[]): [string, Risk[]][] {
  const grouped = new Map<string, Risk[]>();
  for (const risk of risks) {
    grouped.set(risk.statement, [...(grouped.get(risk.statement) ?? []), risk]);
  }
  return [...grouped];
}

const VERBS: Record<Hazard, [named: string, unnamed: string]> = {
  delete_without_where: ["Deletes every row of", "Deletes every row"],
  update_without_where: ["Updates every row of", "Updates every row"],
  drop: ["Drops", "Drops what it names"],
  truncate: ["Empties", "Empties what it names"],
  drop_column: ["Drops the column", "Drops a column"],
};

function sentence({ hazard, targets }: Risk): string {
  const [named, unnamed] = VERBS[hazard];
  return targets.length === 0 ? `${unnamed}.` : `${named} ${targets.join(", ")}.`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const risk = (statement: string, hazard: Hazard, targets: string[]): Risk => ({
    statement,
    hazard,
    targets,
  });

  describe("sentence", () => {
    it("names what the statement acts on", () => {
      expect(sentence(risk("TRUNCATE a, b", "truncate", ["a", "b"]))).toBe("Empties a, b.");
    });

    it("still says what it does when nothing is named", () => {
      expect(sentence(risk("DROP FUNCTION f(int)", "drop", []))).toBe("Drops what it names.");
    });
  });

  describe("byStatement", () => {
    it("keeps a statement's hazards together, in the order they came", () => {
      const first = risk("WITH d AS (DELETE FROM a) UPDATE b SET x = 1", "delete_without_where", [
        "a",
      ]);
      const second = risk("DROP TABLE c", "drop", ["c"]);
      const third = { ...first, hazard: "update_without_where" as const, targets: ["b"] };

      expect(byStatement([first, second, third])).toEqual([
        [first.statement, [first, third]],
        [second.statement, [second]],
      ]);
    });
  });
}
