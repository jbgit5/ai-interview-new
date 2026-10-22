"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useMemo } from "react";
import type { TelemetryEventRow } from "@/lib/observability/types";

type Props = {
  events: TelemetryEventRow[];
};

/** TanStack Table — telemetry event feed with horizontal scroll */
export function EventsDataTable({ events }: Props) {
  const columns = useMemo<ColumnDef<TelemetryEventRow>[]>(
    () => [
      {
        accessorKey: "occurred_at",
        header: "Time",
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap font-mono text-[11px] text-slate-400">
            {new Date(getValue() as string).toLocaleTimeString()}
          </span>
        ),
        size: 100,
      },
      {
        accessorKey: "event_name",
        header: "Event",
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-violet-300">{getValue() as string}</span>
        ),
      },
      {
        id: "turn",
        accessorKey: "turn_index",
        header: "Turn",
        size: 50,
      },
      {
        id: "attrs",
        accessorKey: "attrs",
        header: "Attrs (summary)",
        cell: ({ row }) => {
          const a = row.original.attrs;
          const keys = Object.keys(a).slice(0, 4);
          const s = keys.map((k) => `${k}:${String(a[k]).slice(0, 24)}`).join(" · ");
          return <span className="text-xs text-slate-500 line-clamp-2">{s || "—"}</span>;
        },
      },
    ],
    []
  );

  const table = useReactTable({
    data: events,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="h-[min(420px,50vh)] overflow-auto rounded-xl border border-slate-800">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-slate-950/95 backdrop-blur">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-slate-800">
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500"
                  style={{ width: h.getSize() }}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-slate-800/60 transition-colors hover:bg-slate-800/40"
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-2 align-top">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
