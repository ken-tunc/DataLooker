import { useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import type { TablePage } from "../../bindings/TablePage";
import { formatCell } from "../query/cell";
import type { GridEditing } from "../query/GridRows";
import {
  type DraftRow,
  editCount,
  isDeleted,
  NO_EDITS,
  type PendingEdits,
  rowKeyOf,
  tableEdits,
  withDeleted,
  withEdit,
  withNewRow,
  withNewValue,
  withoutNewRow,
} from "./edits";
import { type TableTab, useCommitEdits } from "./hooks";

/** The row "Remove row" acts on: a draft by its id, a stored row by its key. */
type RemoveTarget =
  | { draft: string }
  | { id: string; key: Record<string, string | null>; version: string };

/**
 * A row of the grid: a draft the reader is adding, or a stored row named by
 * its key. `version` is what a save of the stored row is checked against,
 * and is missing on a page that cannot be edited.
 */
type ShownRow =
  | { draft: DraftRow }
  | { key: Record<string, string | null>; id: string; version: string | undefined };

/**
 * What the reader has changed on a table's page and not yet saved, and how
 * they change it: cells, new rows and rows marked for removal.
 */
export function useRowEdits(
  connectionId: string,
  tab: TableTab,
  page: TablePage | undefined,
  primaryKey: string[],
) {
  const commit = useCommitEdits(connectionId, tab.schema, tab.table);
  const [edits, setEdits] = useState<PendingEdits>(NO_EDITS);
  const [target, setTarget] = useState<RemoveTarget | null>(null);

  const columns = page?.result.columns ?? [];
  // Only a page read with each row's version can be saved against it.
  const pageEditable =
    primaryKey.length > 0 && page !== undefined && page.versions.length === page.result.rows.length;
  // A save clears the edits it started with, so a change made while it is in
  // flight would be lost.
  const editableNow = pageEditable && !commit.isPending;

  // Drafts sit above the page's rows and shift their indexes; `rowAt` is
  // the one place a grid index is turned back into a row.
  const drafts = edits.inserts;
  const shown: QueryResult | undefined = page && {
    ...page.result,
    rows: [
      ...drafts.map((row) => columns.map((column) => row.values[column.name])),
      ...page.result.rows,
    ],
  };

  /** The key of the page's row at `index`, counted below the drafts. */
  function keyOfRow(index: number): Record<string, string | null> | null {
    const values = page?.result.rows[index];
    if (!values) return null;
    const key: Record<string, string | null> = {};
    for (const column of primaryKey) {
      const at = columns.findIndex((candidate) => candidate.name === column);
      const value = at === -1 ? undefined : values[at];
      if (value === undefined) return null;
      // An update casts this text back to the column's type.
      key[column] = value === null ? null : formatCell(value);
    }
    return key;
  }

  function rowAt(row: number): ShownRow | null {
    const draft = drafts[row];
    if (draft) return { draft };
    const index = row - drafts.length;
    const key = keyOfRow(index);
    return key && { key, id: rowKeyOf(key), version: page?.versions[index] };
  }

  function edit(row: number, column: string, value: string | null) {
    const at = rowAt(row);
    if (!at) return;
    if ("draft" in at) {
      setEdits((current) => withNewValue(current, at.draft.id, column, value));
      return;
    }
    const { key, version } = at;
    if (version === undefined) return;
    setEdits((current) => withEdit(current, { key, version, set: {} }, column, value));
  }

  function pendingValue(row: number, column: string) {
    const at = rowAt(row);
    if (!at) return undefined;
    return "draft" in at ? at.draft.values[column] : edits.updates[at.id]?.set[column];
  }

  function rowClass(row: number) {
    const at = rowAt(row);
    if (at && "draft" in at) return "bg-success/10";
    return at && isDeleted(edits, at.key) ? "bg-error/15 line-through opacity-60" : undefined;
  }

  /**
   * Resolved to the row itself, because a draft shifts indexes and a refetch
   * replaces rows; forgotten once the row is gone from the page.
   */
  function selectRow(row: number | null) {
    const at = row === null ? null : rowAt(row);
    if (!at) setTarget(null);
    else if ("draft" in at) setTarget({ draft: at.draft.id });
    else {
      const { id, key, version } = at;
      setTarget(version === undefined ? null : { id, key, version });
    }
  }

  function targetShown(): boolean {
    if (target === null) return false;
    if ("draft" in target) return drafts.some((row) => row.id === target.draft);
    // A row with a new version changed underneath; deleting it would be
    // refused anyway.
    return (page?.result.rows ?? []).some((_, index) => {
      const key = keyOfRow(index);
      return (
        key !== null && rowKeyOf(key) === target.id && page?.versions[index] === target.version
      );
    });
  }

  function toggleRemove() {
    if (target === null || !targetShown()) return;
    if ("draft" in target) {
      setEdits((current) => withoutNewRow(current, target.draft));
      return;
    }
    setEdits((current) => withDeleted(current, target.key, target.version));
  }

  function addRow() {
    setEdits((current) => withNewRow(current, crypto.randomUUID()));
  }

  function save() {
    commit.mutate(tableEdits(connectionId, tab.schema, tab.table, edits), {
      onSuccess: () => setEdits(NO_EDITS),
    });
  }

  const grid: GridEditing | undefined = editableNow
    ? { pendingValue, onEdit: edit, rowClass }
    : undefined;

  return {
    /** The page with the drafts above its rows. */
    shown,
    pageEditable,
    /** What the grid needs to edit cells, while they may be edited. */
    grid,
    pending: editCount(edits),
    commit,
    selectRow,
    canRemove: targetShown(),
    toggleRemove,
    addRow,
    save,
    discard: () => setEdits(NO_EDITS),
  };
}
