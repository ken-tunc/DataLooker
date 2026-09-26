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
  const statements = byStatement(risks);

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
          Run {statements.length === 1 ? "this statement" : "these statements"}?
        </h3>
        <ul className="flex max-h-96 flex-col gap-3 overflow-y-auto py-4">
          {statements.map(([statement, sentences]) => (
            <li key={statement} className="flex flex-col gap-1">
              {sentences.map((said) => (
                <p key={said} className="text-sm">
                  {said}
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

/**
 * What each statement would do, said once: the same statement run twice, or
 * two `DELETE`s of one table in a `WITH`, need not be read twice.
 */
function byStatement(risks: Risk[]): [string, string[]][] {
  const grouped = new Map<string, Set<string>>();
  for (const risk of risks) {
    const said = grouped.get(risk.statement) ?? new Set();
    grouped.set(risk.statement, said.add(sentence(risk)));
  }
  return [...grouped].map(([statement, said]) => [statement, [...said]]);
}

const VERBS: Record<Hazard, [named: string, unnamed: string]> = {
  delete_without_where: ["Deletes every row of", "Deletes every row"],
  update_without_where: ["Updates every row of", "Updates every row"],
  drop: ["Drops", "Drops what it names"],
  truncate: ["Empties", "Empties what it names"],
  drop_column: ["Drops the column", "Drops a column"],
  // Never named: what it acts on is not in the text.
  dynamic: ["Runs SQL", "Runs SQL that cannot be read before it runs"],
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
        [first.statement, ["Deletes every row of a.", "Updates every row of b."]],
        [second.statement, ["Drops c."]],
      ]);
    });

    it("says what a statement run twice would do once", () => {
      const twice = risk("DELETE FROM t", "delete_without_where", ["t"]);

      expect(byStatement([twice, twice])).toEqual([[twice.statement, ["Deletes every row of t."]]]);
    });
  });
}
