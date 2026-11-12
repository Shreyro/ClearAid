"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { gridTheme } from "./LedgerGrid";

/** One column: a header, how to read the value (for sorting and copy) and how to show it. */
export type Col<T> = {
  header: string;
  /** Plain value of the cell, used for sorting and text selection. */
  value?: (row: T) => string | number | null | undefined;
  /** What the cell shows; defaults to the value. */
  render?: (row: T) => ReactNode;
  width?: number;
  minWidth?: number;
  flex?: number;
  align?: "right";
  /** Let the cell grow to fit several lines. */
  wrap?: boolean;
  sortable?: boolean;
  tooltip?: (row: T) => string | undefined;
};

/** A grid that sits inside a card: no outer border, and rows grow to their content. */
const cardTheme = gridTheme.withParams({ wrapperBorder: false, wrapperBorderRadius: 0, headerBackgroundColor: "transparent" });

/**
 * AG Grid for the app's small tables: sorted by clicking a header, resizable
 * columns, text selectable, height follows the rows (no inner scrollbar).
 */
export function DataGrid<T>({
  rows,
  cols,
  rowId,
  minWidth,
  inCard = true,
  selection,
  onRowClicked,
  rowClass,
  ariaLabel,
}: {
  rows: T[];
  cols: Col<T>[];
  rowId?: (row: T) => string;
  /** Narrowest width before the grid scrolls sideways. */
  minWidth?: number;
  inCard?: boolean;
  /** Checkbox selection kept in the caller's state. */
  selection?: { selected: Set<string>; onChange: (ids: Set<string>) => void };
  onRowClicked?: (row: T) => void;
  rowClass?: (row: T) => string | undefined;
  ariaLabel?: string;
}) {
  const api = useRef<GridApi<T> | null>(null);
  const syncing = useRef(false);

  const columnDefs = useMemo<ColDef<T>[]>(
    () =>
      cols.map((c, i) => ({
        colId: `c${i}`,
        headerName: c.header,
        width: c.width,
        minWidth: c.minWidth ?? (c.flex ? 160 : undefined),
        flex: c.flex,
        sortable: c.sortable ?? Boolean(c.value),
        type: c.align === "right" ? "rightAligned" : undefined,
        valueGetter: c.value ? (p) => (p.data ? c.value!(p.data) : null) : undefined,
        cellRenderer: c.render ? (p: { data?: T }) => (p.data ? c.render!(p.data) : null) : undefined,
        tooltipValueGetter: c.tooltip ? (p) => (p.data ? c.tooltip!(p.data) : undefined) : undefined,
        autoHeight: c.wrap,
        wrapText: c.wrap,
        cellClass: [c.align === "right" ? "tnum" : "", c.wrap ? "!leading-normal py-2" : ""].filter(Boolean).join(" ") || undefined,
      })),
    [cols],
  );

  // Cells show the caller's latest state (a saving spinner, a ticked box), so redraw them each render.
  useEffect(() => {
    api.current?.refreshCells({ force: true });
  });

  // Keep the grid's ticks in step with the caller's selection (e.g. after "Clear").
  useEffect(() => {
    if (!selection || !api.current || !rowId) return;
    syncing.current = true;
    api.current.forEachNode((n) => n.data && n.setSelected(selection.selected.has(rowId(n.data))));
    syncing.current = false;
  }, [selection, rowId, rows]);

  return (
    <div className={inCard ? "overflow-x-auto" : undefined} aria-label={ariaLabel}>
      <div style={{ minWidth }}>
        <AgGridReact<T>
          theme={inCard ? cardTheme : gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={rowId ? (p) => rowId(p.data) : undefined}
          domLayout="autoHeight"
          suppressCellFocus={!selection}
          enableCellTextSelection
          tooltipShowDelay={300}
          defaultColDef={{ resizable: true, suppressMovable: true }}
          rowSelection={selection ? { mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false } : undefined}
          onGridReady={(e) => {
            api.current = e.api;
          }}
          onSelectionChanged={(e) => {
            if (!selection || !rowId || syncing.current) return;
            selection.onChange(new Set(e.api.getSelectedRows().map(rowId)));
          }}
          onRowClicked={onRowClicked ? (e) => e.data && onRowClicked(e.data) : undefined}
          getRowClass={rowClass ? (p) => (p.data ? rowClass(p.data) : undefined) : undefined}
        />
      </div>
    </div>
  );
}
