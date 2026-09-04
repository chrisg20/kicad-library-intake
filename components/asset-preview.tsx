"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, FileBox, FileCode2, FileText } from "lucide-react";

import { ModelViewport } from "@/components/model-viewport";
import { parsePlanarPreview } from "@/lib/kicad-preview";
import type { IntakeAsset } from "@/lib/kicad";

const labels = {
  symbol: "Symbol",
  footprint: "Footprint",
  model: "3D model",
  datasheet: "Datasheet",
} as const;

function iconFor(kind: keyof typeof labels) {
  if (kind === "symbol") return <FileCode2 className="size-4" />;
  if (kind === "footprint") return <FileBox className="size-4" />;
  if (kind === "model") return <Box className="size-4" />;
  return <FileText className="size-4" />;
}

function PlanarViewport({ asset }: { asset: IntakeAsset }) {
  const preview = useMemo(() => parsePlanarPreview(asset), [asset]);
  const width = Math.max(preview.bounds.maxX - preview.bounds.minX, 1);
  const height = Math.max(preview.bounds.maxY - preview.bounds.minY, 1);
  const padding = Math.max(width, height) * 0.14;
  const viewBox = [
    preview.bounds.minX - padding,
    -preview.bounds.maxY - padding,
    width + padding * 2,
    height + padding * 2,
  ].join(" ");

  if (!preview.primitives.length) {
    return <PreviewMessage>Geometry was not found in this file.</PreviewMessage>;
  }

  return (
    <div className="preview-stage" aria-label={`${labels[asset.kind as "symbol" | "footprint"]} 2D preview`}>
      <svg viewBox={viewBox} className="h-full w-full" role="img">
        <g fill="none" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
          {preview.primitives.map((primitive, index) => {
            const key = `${primitive.type}-${index}`;
            if (primitive.type === "line") {
              return (
                <line
                  key={key}
                  x1={primitive.start.x}
                  y1={-primitive.start.y}
                  x2={primitive.end.x}
                  y2={-primitive.end.y}
                  className={primitive.role === "pin" ? "preview-pin" : "preview-drawing"}
                />
              );
            }
            if (primitive.type === "polyline") {
              return (
                <polyline
                  key={key}
                  points={primitive.points.map((point) => `${point.x},${-point.y}`).join(" ")}
                  className="preview-drawing"
                />
              );
            }
            if (primitive.type === "rect") {
              return (
                <rect
                  key={key}
                  x={Math.min(primitive.start.x, primitive.end.x)}
                  y={-Math.max(primitive.start.y, primitive.end.y)}
                  width={Math.abs(primitive.end.x - primitive.start.x)}
                  height={Math.abs(primitive.end.y - primitive.start.y)}
                  className="preview-drawing"
                />
              );
            }
            if (primitive.type === "circle") {
              return <circle key={key} cx={primitive.center.x} cy={-primitive.center.y} r={primitive.radius} className="preview-drawing" />;
            }
            const centerY = -primitive.center.y;
            const rounded = primitive.shape === "round" ? Math.min(primitive.width, primitive.height) / 2 : primitive.shape === "oval" ? Math.min(primitive.width, primitive.height) / 2 : Math.min(primitive.width, primitive.height) * 0.08;
            return (
              <g key={key} transform={`rotate(${-primitive.rotation} ${primitive.center.x} ${centerY})`}>
                <rect
                  x={primitive.center.x - primitive.width / 2}
                  y={centerY - primitive.height / 2}
                  width={primitive.width}
                  height={primitive.height}
                  rx={rounded}
                  className="preview-pad"
                />
                {primitive.drill > 0 && (
                  <circle cx={primitive.center.x} cy={centerY} r={primitive.drill / 2} className="preview-drill" />
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <span className="preview-grid-label">2D · fit to geometry</span>
    </div>
  );
}

function DatasheetViewport({ asset }: { asset: IntakeAsset }) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([new Uint8Array(asset.bytes)], { type: "application/pdf" })),
    [asset],
  );
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);
  return (
    <div className="preview-stage bg-slate-200">
      <object data={url} type="application/pdf" className="h-full w-full" aria-label={`${asset.name} datasheet preview`}>
        <PreviewMessage>PDF preview is unavailable in this browser.</PreviewMessage>
      </object>
    </div>
  );
}

function PreviewMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="preview-stage grid place-items-center p-8 text-center">
      <div>
        <Box className="mx-auto size-7 text-slate-600" />
        <p className="mt-3 max-w-sm text-sm leading-6 text-slate-500">{children}</p>
      </div>
    </div>
  );
}

export function AssetPreviewGallery({ assets }: { assets: IntakeAsset[] }) {
  const previewable = assets.filter((asset) => ["symbol", "footprint", "model", "datasheet"].includes(asset.kind));
  const [selectedId, setSelectedId] = useState("");
  const selected = previewable.find((asset) => asset.id === selectedId) ?? previewable[0];

  if (!selected) return null;

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/35">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-3.5 py-3">
        <div>
          <div className="text-sm font-medium text-slate-200">Asset preview</div>
          <div className="mt-0.5 max-w-[44rem] truncate text-xs text-slate-600">{selected.name}</div>
        </div>
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600 sm:block">Local only</span>
      </div>
      <div className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-slate-800 bg-slate-950/45 p-2">
        {previewable.map((asset) => {
          const active = asset.id === selected.id;
          const kind = asset.kind as keyof typeof labels;
          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => setSelectedId(asset.id)}
              className={`flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm transition ${active ? "border-teal-400/35 bg-teal-400/10 text-teal-200" : "border-transparent text-slate-500 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-300"}`}
            >
              {iconFor(kind)}
              {labels[kind]} · {asset.name}
            </button>
          );
        })}
      </div>
      <div className="p-3">
        {selected.kind === "symbol" || selected.kind === "footprint" ? <PlanarViewport asset={selected} /> : null}
        {selected.kind === "model" ? <ModelViewport asset={selected} /> : null}
        {selected.kind === "datasheet" ? <DatasheetViewport asset={selected} /> : null}
      </div>
    </div>
  );
}
