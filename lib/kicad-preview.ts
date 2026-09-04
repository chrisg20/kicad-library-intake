import type { IntakeAsset } from "@/lib/kicad";

export type Point2 = { x: number; y: number };

export type PlanarPrimitive =
  | { type: "line"; start: Point2; end: Point2; role: "drawing" | "pin" }
  | { type: "polyline"; points: Point2[]; role: "drawing" }
  | { type: "rect"; start: Point2; end: Point2; role: "drawing" }
  | { type: "circle"; center: Point2; radius: number; role: "drawing" }
  | {
      type: "pad";
      center: Point2;
      width: number;
      height: number;
      rotation: number;
      shape: "rect" | "round" | "oval";
      drill: number;
    };

export type PlanarPreview = {
  primitives: PlanarPrimitive[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

export type Point3 = { x: number; y: number; z: number };

export type ModelPreview = {
  points: Point3[];
  edges: Array<[number, number]>;
  format: "STEP" | "VRML" | "IGES" | "Unknown";
};

const decoder = new TextDecoder("utf-8", { fatal: false });
const numberPattern = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[EeDd][-+]?\\d+)?";

function finite(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(/[dD]/, "e"));
  return Number.isFinite(parsed) ? parsed : null;
}

function formsByHead(source: string, heads: Set<string>) {
  const forms: Array<{ head: string; source: string }> = [];
  const stack: Array<{ start: number; head: string }> = [];
  let inString = false;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inComment) {
      if (character === "\n") inComment = false;
      continue;
    }
    if (!inString && character === ";") {
      inComment = true;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "(") {
      const head = source.slice(index + 1).match(/^\s*([^\s()]+)/)?.[1] ?? "";
      stack.push({ start: index, head });
    } else if (character === ")") {
      const open = stack.pop();
      if (open && heads.has(open.head)) {
        forms.push({ head: open.head, source: source.slice(open.start, index + 1) });
      }
    }
  }
  return forms;
}

function coordinate(form: string, name: string): Point2 | null {
  const match = form.match(new RegExp(`\\(${name}\\s+(${numberPattern})\\s+(${numberPattern})`, "i"));
  const x = finite(match?.[1]);
  const y = finite(match?.[2]);
  return x === null || y === null ? null : { x, y };
}

function allCoordinates(form: string, name = "xy") {
  const expression = new RegExp(`\\(${name}\\s+(${numberPattern})\\s+(${numberPattern})`, "gi");
  return [...form.matchAll(expression)]
    .map((match) => ({ x: finite(match[1]), y: finite(match[2]) }))
    .filter((point): point is { x: number; y: number } => point.x !== null && point.y !== null);
}

function boundsFor(primitives: PlanarPrimitive[]) {
  const points: Point2[] = [];
  for (const primitive of primitives) {
    if (primitive.type === "line") points.push(primitive.start, primitive.end);
    if (primitive.type === "polyline") points.push(...primitive.points);
    if (primitive.type === "rect") points.push(primitive.start, primitive.end);
    if (primitive.type === "circle") {
      points.push(
        { x: primitive.center.x - primitive.radius, y: primitive.center.y - primitive.radius },
        { x: primitive.center.x + primitive.radius, y: primitive.center.y + primitive.radius },
      );
    }
    if (primitive.type === "pad") {
      const radius = Math.hypot(primitive.width, primitive.height) / 2;
      points.push(
        { x: primitive.center.x - radius, y: primitive.center.y - radius },
        { x: primitive.center.x + radius, y: primitive.center.y + radius },
      );
    }
  }
  if (!points.length) return { minX: -5, minY: -5, maxX: 5, maxY: 5 };
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function parsePad(form: string): PlanarPrimitive | null {
  const header = form.match(/^\(pad\s+(?:"(?:\\.|[^"\\])*"|[^\s)]+)\s+[^\s)]+\s+([^\s)]+)/i);
  const atMatch = form.match(new RegExp(`\\(at\\s+(${numberPattern})\\s+(${numberPattern})(?:\\s+(${numberPattern}))?`, "i"));
  const sizeMatch = form.match(new RegExp(`\\(size\\s+(${numberPattern})\\s+(${numberPattern})`, "i"));
  const x = finite(atMatch?.[1]);
  const y = finite(atMatch?.[2]);
  const width = finite(sizeMatch?.[1]);
  const height = finite(sizeMatch?.[2]);
  if (x === null || y === null || width === null || height === null) return null;
  const drillMatch = form.match(new RegExp(`\\(drill(?:\\s+oval)?\\s+(${numberPattern})`, "i"));
  const rawShape = header?.[1]?.toLowerCase() ?? "rect";
  return {
    type: "pad",
    center: { x, y },
    width,
    height,
    rotation: finite(atMatch?.[3]) ?? 0,
    shape: rawShape === "circle" ? "round" : rawShape === "oval" ? "oval" : "rect",
    drill: finite(drillMatch?.[1]) ?? 0,
  };
}

export function parsePlanarPreview(asset: Pick<IntakeAsset, "kind" | "bytes">): PlanarPreview {
  const source = decoder.decode(asset.bytes);
  const primitives: PlanarPrimitive[] = [];
  const heads =
    asset.kind === "symbol"
      ? new Set(["rectangle", "polyline", "circle", "arc", "pin"])
      : new Set(["fp_line", "fp_rect", "fp_circle", "fp_arc", "pad"]);

  for (const form of formsByHead(source, heads)) {
    if (form.head === "rectangle" || form.head === "fp_rect") {
      const start = coordinate(form.source, "start");
      const end = coordinate(form.source, "end");
      if (start && end) primitives.push({ type: "rect", start, end, role: "drawing" });
    } else if (form.head === "polyline") {
      const points = allCoordinates(form.source);
      if (points.length > 1) primitives.push({ type: "polyline", points, role: "drawing" });
    } else if (form.head === "circle" || form.head === "fp_circle") {
      const center = coordinate(form.source, "center");
      const end = coordinate(form.source, "end");
      const radiusMatch = form.source.match(new RegExp(`\\(radius\\s+(${numberPattern})`, "i"));
      const radius = finite(radiusMatch?.[1]) ?? (center && end ? Math.hypot(end.x - center.x, end.y - center.y) : null);
      if (center && radius !== null) primitives.push({ type: "circle", center, radius, role: "drawing" });
    } else if (form.head === "arc" || form.head === "fp_arc") {
      const points = [coordinate(form.source, "start"), coordinate(form.source, "mid"), coordinate(form.source, "end")].filter(
        (point): point is Point2 => Boolean(point),
      );
      if (points.length > 1) primitives.push({ type: "polyline", points, role: "drawing" });
    } else if (form.head === "fp_line") {
      const start = coordinate(form.source, "start");
      const end = coordinate(form.source, "end");
      if (start && end) primitives.push({ type: "line", start, end, role: "drawing" });
    } else if (form.head === "pin") {
      const atMatch = form.source.match(new RegExp(`\\(at\\s+(${numberPattern})\\s+(${numberPattern})\\s+(${numberPattern})`, "i"));
      const lengthMatch = form.source.match(new RegExp(`\\(length\\s+(${numberPattern})`, "i"));
      const x = finite(atMatch?.[1]);
      const y = finite(atMatch?.[2]);
      const angle = finite(atMatch?.[3]);
      const length = finite(lengthMatch?.[1]);
      if (x !== null && y !== null && angle !== null && length !== null) {
        const radians = (angle * Math.PI) / 180;
        primitives.push({
          type: "line",
          start: { x, y },
          end: { x: x + Math.cos(radians) * length, y: y + Math.sin(radians) * length },
          role: "pin",
        });
      }
    } else if (form.head === "pad") {
      const pad = parsePad(form.source);
      if (pad) primitives.push(pad);
    }
  }
  return { primitives, bounds: boundsFor(primitives) };
}

function pushUniquePoint(points: Point3[], lookup: Map<string, number>, point: Point3) {
  const key = `${point.x.toPrecision(9)}:${point.y.toPrecision(9)}:${point.z.toPrecision(9)}`;
  const existing = lookup.get(key);
  if (existing !== undefined) return existing;
  const index = points.length;
  points.push(point);
  lookup.set(key, index);
  return index;
}

function pointTriples(value: string) {
  const values = value.match(new RegExp(numberPattern, "g"))?.map((token) => finite(token)).filter((item): item is number => item !== null) ?? [];
  const points: Point3[] = [];
  for (let index = 0; index + 2 < values.length; index += 3) {
    points.push({ x: values[index], y: values[index + 1], z: values[index + 2] });
  }
  return points;
}

function parseStep(source: string): ModelPreview {
  const points: Point3[] = [];
  const lookup = new Map<string, number>();
  const expression = /CARTESIAN_POINT\s*\([^,]*,\s*\(([^)]*)\)\s*\)/gi;
  for (const match of source.matchAll(expression)) {
    const point = pointTriples(match[1])[0];
    if (point) pushUniquePoint(points, lookup, point);
  }
  return { points: points.slice(0, 12000), edges: [], format: "STEP" };
}

function parseVrml(source: string): ModelPreview {
  const points: Point3[] = [];
  const edges: Array<[number, number]> = [];
  const lookup = new Map<string, number>();
  for (const match of source.matchAll(/point\s*\[([\s\S]*?)\]/gi)) {
    for (const point of pointTriples(match[1])) pushUniquePoint(points, lookup, point);
  }
  const indexBlock = source.match(/coordIndex\s*\[([\s\S]*?)\]/i)?.[1];
  if (indexBlock) {
    const indices = indexBlock.match(/-?\d+/g)?.map(Number) ?? [];
    let face: number[] = [];
    for (const index of indices) {
      if (index < 0) {
        for (let cursor = 0; cursor < face.length; cursor += 1) {
          const start = face[cursor];
          const end = face[(cursor + 1) % face.length];
          if (start < points.length && end < points.length) edges.push([start, end]);
        }
        face = [];
      } else face.push(index);
    }
  }
  return { points: points.slice(0, 12000), edges: edges.slice(0, 24000), format: "VRML" };
}

function parseIges(source: string): ModelPreview {
  const points: Point3[] = [];
  const edges: Array<[number, number]> = [];
  const lookup = new Map<string, number>();
  const parameterData = source
    .split(/\r?\n/)
    .filter((line) => line[72]?.toUpperCase() === "P")
    .map((line) => line.slice(0, 64))
    .join("");
  for (const record of parameterData.split(";")) {
    const values = record.match(new RegExp(numberPattern, "g")) ?? [];
    const entity = Number(values[0]);
    if (entity === 116 && values.length >= 4) {
      const point = { x: finite(values[1]), y: finite(values[2]), z: finite(values[3]) };
      if (point.x !== null && point.y !== null && point.z !== null) pushUniquePoint(points, lookup, point as Point3);
    }
    if (entity === 110 && values.length >= 7) {
      const first = { x: finite(values[1]), y: finite(values[2]), z: finite(values[3]) };
      const second = { x: finite(values[4]), y: finite(values[5]), z: finite(values[6]) };
      if (first.x !== null && first.y !== null && first.z !== null && second.x !== null && second.y !== null && second.z !== null) {
        const start = pushUniquePoint(points, lookup, first as Point3);
        const end = pushUniquePoint(points, lookup, second as Point3);
        edges.push([start, end]);
      }
    }
  }
  return { points: points.slice(0, 12000), edges: edges.slice(0, 24000), format: "IGES" };
}

export function parseModelPreview(asset: Pick<IntakeAsset, "name" | "bytes">): ModelPreview {
  const source = decoder.decode(asset.bytes);
  const name = asset.name.toLowerCase();
  if (/\.(?:step|stp)$/.test(name) || /ISO-10303-21/i.test(source.slice(0, 4096))) return parseStep(source);
  if (/\.(?:iges|igs)$/.test(name)) return parseIges(source);
  if (/\.(?:wrl|vrml)$/.test(name) || /#VRML/i.test(source.slice(0, 4096))) return parseVrml(source);
  return { points: [], edges: [], format: "Unknown" };
}
