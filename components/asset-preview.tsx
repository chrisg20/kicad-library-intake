"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, FileBox, FileCode2, FileText, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { parseModelPreview, parsePlanarPreview, type Point3 } from "@/lib/kicad-preview";
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

function rotatePoint(point: Point3, yaw: number, pitch: number) {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const x = point.x * cosYaw - point.z * sinYaw;
  const z = point.x * sinYaw + point.z * cosYaw;
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  return { x, y: point.y * cosPitch - z * sinPitch, z: point.y * sinPitch + z * cosPitch };
}

function ModelViewport({ asset }: { asset: IntakeAsset }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const model = useMemo(() => parseModelPreview(asset), [asset]);
  const [rotation, setRotation] = useState({ yaw: -0.65, pitch: 0.48 });
  const [zoom, setZoom] = useState(1);

  const normalized = useMemo(() => {
    if (!model.points.length) return [];
    const xs = model.points.map((point) => point.x);
    const ys = model.points.map((point) => point.y);
    const zs = model.points.map((point) => point.z);
    const center = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
      z: (Math.min(...zs) + Math.max(...zs)) / 2,
    };
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs), 0.001);
    return model.points.map((point) => ({ x: (point.x - center.x) / span, y: (point.y - center.y) / span, z: (point.z - center.z) / span }));
  }, [model.points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !normalized.length) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    function draw() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas!.getBoundingClientRect();
      const width = Math.max(Math.round(rect.width), 1);
      const height = Math.max(Math.round(rect.height), 1);
      if (canvas!.width !== width * ratio || canvas!.height !== height * ratio) {
        canvas!.width = width * ratio;
        canvas!.height = height * ratio;
      }
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      context!.clearRect(0, 0, width, height);
      const gradient = context!.createRadialGradient(width * 0.5, height * 0.42, 10, width * 0.5, height * 0.5, Math.max(width, height) * 0.72);
      gradient.addColorStop(0, "#14242d");
      gradient.addColorStop(1, "#070b11");
      context!.fillStyle = gradient;
      context!.fillRect(0, 0, width, height);

      context!.strokeStyle = "rgba(100, 116, 139, 0.13)";
      context!.lineWidth = 1;
      const grid = 28;
      for (let x = width % grid; x < width; x += grid) {
        context!.beginPath();
        context!.moveTo(x, 0);
        context!.lineTo(x, height);
        context!.stroke();
      }
      for (let y = height % grid; y < height; y += grid) {
        context!.beginPath();
        context!.moveTo(0, y);
        context!.lineTo(width, y);
        context!.stroke();
      }

      const scale = Math.min(width, height) * 0.72 * zoom;
      const projected = normalized.map((point) => {
        const rotated = rotatePoint(point, rotation.yaw, rotation.pitch);
        const perspective = 1 / Math.max(0.72, 1.42 + rotated.z * 0.42);
        return { x: width / 2 + rotated.x * scale * perspective, y: height / 2 - rotated.y * scale * perspective, z: rotated.z };
      });

      context!.strokeStyle = "rgba(94, 234, 212, 0.5)";
      context!.lineWidth = 1;
      context!.beginPath();
      for (const [start, end] of model.edges) {
        const a = projected[start];
        const b = projected[end];
        if (!a || !b) continue;
        context!.moveTo(a.x, a.y);
        context!.lineTo(b.x, b.y);
      }
      context!.stroke();

      const stride = Math.max(1, Math.ceil(projected.length / 4200));
      const visible = projected.filter((_point, index) => index % stride === 0).sort((a, b) => a.z - b.z);
      for (const point of visible) {
        const alpha = 0.46 + (point.z + 0.5) * 0.35;
        context!.fillStyle = `rgba(103, 232, 249, ${Math.max(0.25, Math.min(alpha, 0.92))})`;
        context!.beginPath();
        context!.arc(point.x, point.y, model.edges.length ? 1.35 : 1.8, 0, Math.PI * 2);
        context!.fill();
      }
    }

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [model.edges, normalized, rotation, zoom]);

  if (!model.points.length) {
    return (
      <PreviewMessage>
        This {model.format === "Unknown" ? "model" : model.format} file can be stored, but it does not expose previewable text geometry.
      </PreviewMessage>
    );
  }

  return (
    <div className="preview-stage relative">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none cursor-grab active:cursor-grabbing"
        aria-label={`Interactive ${model.format} 3D geometry preview`}
        onPointerDown={(event) => {
          dragRef.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          const dx = event.clientX - dragRef.current.x;
          const dy = event.clientY - dragRef.current.y;
          dragRef.current = { x: event.clientX, y: event.clientY };
          setRotation((current) => ({ yaw: current.yaw + dx * 0.012, pitch: Math.max(-1.45, Math.min(1.45, current.pitch + dy * 0.012)) }));
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onWheel={(event) => {
          event.preventDefault();
          setZoom((current) => Math.max(0.55, Math.min(2.4, current * (event.deltaY > 0 ? 0.92 : 1.08))));
        }}
      />
      <div className="pointer-events-none absolute top-3 left-3 rounded-md border border-slate-700/80 bg-slate-950/75 px-2.5 py-1.5 font-mono text-[11px] text-slate-400">
        {model.format} · {model.points.length.toLocaleString()} points
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="absolute top-3 right-3 border-slate-700 bg-slate-950/75 text-slate-400 hover:bg-slate-800 hover:text-white"
        aria-label="Reset 3D view"
        onClick={() => {
          setRotation({ yaw: -0.65, pitch: 0.48 });
          setZoom(1);
        }}
      >
        <RotateCcw />
      </Button>
      <span className="preview-grid-label">Drag to orbit · wheel to zoom</span>
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
              {labels[kind]}
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
