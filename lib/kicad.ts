import { unzipSync } from "fflate";

export type AssetKind =
  | "symbol"
  | "footprint"
  | "model"
  | "datasheet"
  | "legacy-symbol"
  | "unsupported";

export type IntakeAsset = {
  id: string;
  name: string;
  sourceName: string;
  bytes: Uint8Array;
  kind: AssetKind;
  warnings: string[];
};

export type PartMetadata = {
  manufacturer: string;
  mpn: string;
  libraryName: string;
  packageName: string;
  category: "Custom" | "RF" | "Modules";
  datasheet: string;
  description: string;
  verified: "Unverified" | "Datasheet checked" | "Fabricated" | "Electrically tested";
  sourceUrl: string;
};

export type NormalizedAsset = {
  id: string;
  kind: Exclude<AssetKind, "legacy-symbol" | "unsupported"> | "metadata";
  inputName: string;
  outputPath: string;
  bytes: Uint8Array;
  strategy: "replace" | "merge-symbol-library";
  notes: string[];
};

export type NormalizedPackage = {
  componentName: string;
  symbolName: string | null;
  footprintNames: string[];
  files: NormalizedAsset[];
  warnings: string[];
  completeness: number;
};

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 200;
const MAX_EXPANDED_BYTES = 80 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

export const acceptedFileTypes = [
  ".kicad_sym",
  ".kicad_mod",
  ".step",
  ".stp",
  ".iges",
  ".igs",
  ".wrl",
  ".pdf",
  ".zip",
  ".lib",
  ".dcm",
].join(",");

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function extension(name: string) {
  const clean = name.toLowerCase().split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot) : "";
}

export function classifyAsset(name: string, bytes?: Uint8Array): AssetKind {
  const ext = extension(name);
  if (ext === ".kicad_sym") return "symbol";
  if (ext === ".kicad_mod") return "footprint";
  if ([".step", ".stp", ".iges", ".igs", ".wrl"].includes(ext)) return "model";
  if (ext === ".pdf") return "datasheet";
  if ([".lib", ".dcm"].includes(ext)) return "legacy-symbol";

  if (bytes && bytes.length < 4 * 1024 * 1024) {
    const head = textDecoder.decode(bytes.slice(0, 4096)).trimStart();
    if (head.startsWith("(kicad_symbol_lib")) return "symbol";
    if (head.startsWith("(footprint") || head.startsWith("(module")) return "footprint";
    if (head.includes("ISO-10303-21")) return "model";
  }
  return "unsupported";
}

function assetWarnings(name: string, kind: AssetKind): string[] {
  if (kind === "legacy-symbol") {
    return [
      `${name} uses KiCad's legacy .lib/.dcm format. Export it as .kicad_sym before committing.`,
    ];
  }
  if (kind === "unsupported") {
    return [`${name} is not a supported KiCad library asset.`];
  }
  return [];
}

function makeAsset(name: string, sourceName: string, bytes: Uint8Array): IntakeAsset {
  const kind = classifyAsset(name, bytes);
  return {
    id: randomId(),
    name: basename(name),
    sourceName,
    bytes,
    kind,
    warnings: assetWarnings(basename(name), kind),
  };
}

export async function ingestBrowserFiles(files: File[]): Promise<IntakeAsset[]> {
  const assets: IntakeAsset[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${file.name} is larger than the 40 MB upload limit.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (extension(file.name) !== ".zip") {
      assets.push(makeAsset(file.name, file.name, bytes));
      continue;
    }

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error(`${file.name} could not be opened as a ZIP archive.`);
    }
    const names = Object.keys(entries).filter(
      (name) => !name.endsWith("/") && !name.split("/").some((part) => part.startsWith(".")),
    );
    if (names.length > MAX_ARCHIVE_FILES) {
      throw new Error(`${file.name} contains more than ${MAX_ARCHIVE_FILES} files.`);
    }
    const expandedBytes = names.reduce((total, name) => total + entries[name].byteLength, 0);
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error(`${file.name} expands beyond the 80 MB safety limit.`);
    }
    for (const name of names) {
      const safeName = name.replaceAll("\\", "/");
      if (safeName.split("/").includes("..")) continue;
      const asset = makeAsset(safeName, `${file.name} / ${safeName}`, entries[name]);
      if (asset.kind !== "unsupported" || extension(safeName) === ".kicad_sch") {
        assets.push(asset);
      }
    }
  }
  return assets;
}

export function basename(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function decodeQuoted(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
}

function propertyValue(source: string, property: string) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`\\(property\\s+"${escaped}"\\s+"((?:\\\\.|[^"\\\\])*)"`, "i"),
  );
  return match ? decodeQuoted(match[1]) : "";
}

function firstSymbolName(source: string) {
  const match = source.match(/\(symbol\s+"((?:\\.|[^"\\])*)"/);
  return match ? decodeQuoted(match[1]) : "";
}

function firstFootprintName(source: string) {
  const match = source.match(/\((?:footprint|module)\s+"?([^"\s)]+)"?/);
  return match ? decodeQuoted(match[1]) : "";
}

export function inferMetadataFromAssets(assets: IntakeAsset[]): Partial<PartMetadata> {
  const symbol = assets.find((asset) => asset.kind === "symbol");
  const footprint = assets.find((asset) => asset.kind === "footprint");
  const result: Partial<PartMetadata> = {};

  if (symbol) {
    const source = textDecoder.decode(symbol.bytes);
    const symbolName = firstSymbolName(source);
    const value = propertyValue(source, "Value");
    result.mpn = propertyValue(source, "MPN") || value || symbolName;
    result.libraryName = value || symbolName || result.mpn;
    result.manufacturer = propertyValue(source, "Manufacturer");
    result.datasheet = propertyValue(source, "Datasheet");
    result.description = propertyValue(source, "Description");
    const footprintRef = propertyValue(source, "Footprint");
    if (footprintRef) {
      result.packageName = footprintRef.split(":").at(-1)?.replace(`${result.libraryName ?? ""}_`, "") ?? "";
    }
  }

  if (!result.packageName && footprint) {
    const footprintName = firstFootprintName(textDecoder.decode(footprint.bytes));
    if (footprintName) result.packageName = footprintName.replace(`${result.libraryName ?? ""}_`, "");
  }
  return result;
}

export function sanitizeKiCadName(value: string, fallback = "Unnamed") {
  const sanitized = value
    .trim()
    .replace(/[\\/:*?"<>|#%{}]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return sanitized || fallback;
}

function escapeKiCadString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

function markIntakeGenerator(source: string) {
  let rewritten = source.replace(
    /(\(generator\s+)("(?:\\.|[^"\\])*"|[^\s)]+)/,
    (_match, prefix: string) => `${prefix}kicad_library_intake`,
  );
  rewritten = rewritten.replace(
    /(\(generator_version\s+)("(?:\\.|[^"\\])*"|[^\s)]+)/,
    (_match, prefix: string) => `${prefix}"1.0"`,
  );
  return rewritten;
}

type FormSpan = { start: number; end: number; head: string };

function rootChildForms(source: string): FormSpan[] {
  const rootStart = source.indexOf("(");
  if (rootStart < 0) return [];
  const forms: FormSpan[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let inComment = false;
  let childStart = -1;

  for (let i = rootStart; i < source.length; i += 1) {
    const char = source[i];
    if (inComment) {
      if (char === "\n") inComment = false;
      continue;
    }
    if (!inString && char === ";") {
      inComment = true;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "(") {
      if (depth === 1) childStart = i;
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 2 && childStart >= 0) {
        const end = i + 1;
        const head = source.slice(childStart + 1, end).match(/^([^\s()]+)/)?.[1] ?? "";
        forms.push({ start: childStart, end, head });
        childStart = -1;
      }
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return forms;
}

function rootClosingParen(source: string) {
  const rootStart = source.indexOf("(");
  if (rootStart < 0) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let inComment = false;
  for (let i = rootStart; i < source.length; i += 1) {
    const char = source[i];
    if (inComment) {
      if (char === "\n") inComment = false;
      continue;
    }
    if (!inString && char === ";") {
      inComment = true;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function symbolBlocks(source: string) {
  if (!source.trimStart().startsWith("(kicad_symbol_lib")) {
    throw new Error("The symbol file is not a modern .kicad_sym library.");
  }
  return rootChildForms(source)
    .filter((form) => form.head === "symbol")
    .map((form) => ({ ...form, source: source.slice(form.start, form.end) }));
}

function replaceProperty(source: string, name: string, value: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `(\\(property\\s+"${escapedName}"\\s+")((?:\\\\.|[^"\\\\])*)(")`,
    "i",
  );
  if (expression.test(source)) {
    return source.replace(expression, (_match, prefix: string, _previous: string, suffix: string) => {
      return `${prefix}${escapeKiCadString(value)}${suffix}`;
    });
  }

  const existingProperties = rootChildForms(source).filter((form) => form.head === "property");
  const usedIds = existingProperties
    .map((form) => source.slice(form.start, form.end).match(/\(id\s+(\d+)\)/)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  const nextPropertyId = Math.max(3, ...usedIds) + 1;
  const propertyForm = [
    `    (property "${escapeKiCadString(name)}" "${escapeKiCadString(value)}"`,
    `      (id ${nextPropertyId})`,
    "      (at 0 0 0)",
    "      (effects",
    "        (font",
    "          (size 1.27 1.27)",
    "        )",
    "        hide",
    "      )",
    "    )",
  ].join("\n");
  if (existingProperties.length) {
    const insertion = existingProperties.at(-1)!.end;
    return `${source.slice(0, insertion)}\n${propertyForm}${source.slice(insertion)}`;
  }
  const firstLineEnd = source.indexOf("\n");
  const insertion = firstLineEnd >= 0 ? firstLineEnd + 1 : source.length - 1;
  return `${source.slice(0, insertion)}${propertyForm}\n${source.slice(insertion)}`;
}

function renameSymbolBlock(
  block: string,
  newName: string,
  footprintReference: string,
  metadata: PartMetadata,
) {
  const oldName = firstSymbolName(block);
  const escapedNewName = escapeKiCadString(newName);
  let result = block.replace(
    /(\(symbol\s+")((?:\\.|[^"\\])*)(")/g,
    (full, prefix: string, candidate: string, suffix: string) => {
      const decoded = decodeQuoted(candidate);
      if (decoded === oldName) return `${prefix}${escapedNewName}${suffix}`;
      if (decoded.startsWith(`${oldName}_`)) {
        return `${prefix}${escapedNewName}${escapeKiCadString(decoded.slice(oldName.length))}${suffix}`;
      }
      return full;
    },
  );
  const properties: Array<[string, string]> = [
    ["Value", metadata.libraryName],
    ["Footprint", footprintReference],
    ["Datasheet", metadata.datasheet],
    ["Description", metadata.description],
    ["Manufacturer", metadata.manufacturer],
    ["MPN", metadata.mpn],
    ["Source", metadata.sourceUrl],
    ["Verified", metadata.verified],
  ];
  for (const [name, value] of properties) {
    if (value) result = replaceProperty(result, name, value);
  }
  return result;
}

function rewriteSymbolLibrary(
  source: string,
  baseName: string,
  footprintReference: string,
  metadata: PartMetadata,
) {
  const blocks = symbolBlocks(source);
  if (!blocks.length) throw new Error("No symbols were found in the .kicad_sym file.");
  let rewritten = source;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const name = index === 0 ? baseName : `${baseName}_${sanitizeKiCadName(firstSymbolName(block.source))}`;
    const replacement = renameSymbolBlock(block.source, name, footprintReference, metadata);
    rewritten = `${rewritten.slice(0, block.start)}${replacement}${rewritten.slice(block.end)}`;
  }
  return { source: markIntakeGenerator(rewritten), symbolCount: blocks.length };
}

function appendModelBlock(source: string, modelReference: string) {
  const closing = rootClosingParen(source);
  if (closing < 0) return source;
  const model = [
    `  (model "${escapeKiCadString(modelReference)}"`,
    "    (at (xyz 0 0 0))",
    "    (scale (xyz 1 1 1))",
    "    (rotate (xyz 0 0 0))",
    "  )",
  ].join("\n");
  return `${source.slice(0, closing).trimEnd()}\n${model}\n${source.slice(closing)}`;
}

function rewriteFootprint(source: string, newName: string, modelReference?: string) {
  let rewritten = source.replace(
    /(\((?:footprint|module)\s+")((?:\\.|[^"\\])*)(")/,
    `$1${escapeKiCadString(newName)}$3`,
  );
  if (rewritten === source) {
    rewritten = source.replace(
      /(\((?:footprint|module)\s+)([^\s)]+)/,
      `$1"${escapeKiCadString(newName)}"`,
    );
  }
  rewritten = markIntakeGenerator(rewritten);
  if (!modelReference) return rewritten;
  const modelPath = /(\(model\s+)("(?:\\.|[^"\\])*"|[^\s)]+)/;
  if (modelPath.test(rewritten)) {
    return rewritten.replace(modelPath, `$1"${escapeKiCadString(modelReference)}"`);
  }
  return appendModelBlock(rewritten, modelReference);
}

async function sha256(bytes: Uint8Array) {
  const owned = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function symbolNameFromBlock(block: string) {
  return firstSymbolName(block);
}

export function mergeKicadSymbolLibraries(existing: string | null, incoming: string[]) {
  if (!incoming.length) throw new Error("No incoming symbol libraries were provided.");
  let merged = existing?.trim() ? existing : incoming.shift()!;
  if (!merged.trimStart().startsWith("(kicad_symbol_lib")) {
    throw new Error("The target symbol library is not a valid .kicad_sym file.");
  }

  for (const library of incoming) {
    for (const incomingBlock of symbolBlocks(library)) {
      const name = firstSymbolName(incomingBlock.source);
      const current = symbolBlocks(merged);
      const matching = current.find((block) => firstSymbolName(block.source) === name);
      if (matching) {
        merged = `${merged.slice(0, matching.start)}${incomingBlock.source}${merged.slice(matching.end)}`;
      } else {
        const closing = rootClosingParen(merged);
        if (closing < 0) throw new Error("The target symbol library has unbalanced parentheses.");
        merged = `${merged.slice(0, closing).trimEnd()}\n  ${incomingBlock.source.trim()}\n${merged.slice(closing)}`;
      }
    }
  }
  return `${markIntakeGenerator(merged).trimEnd()}\n`;
}

export async function normalizeAssets(
  assets: IntakeAsset[],
  metadata: PartMetadata,
): Promise<NormalizedPackage> {
  if (!metadata.mpn.trim()) throw new Error("A manufacturer part number is required.");
  if (!metadata.libraryName.trim()) throw new Error("A KiCad library name is required.");
  const supported = assets.filter(
    (asset) => asset.kind !== "unsupported" && asset.kind !== "legacy-symbol",
  );
  if (!supported.length) throw new Error("Add at least one supported KiCad asset.");

  const partName = sanitizeKiCadName(metadata.libraryName);
  const category = metadata.category;
  const footprints = supported.filter((asset) => asset.kind === "footprint");
  const models = supported.filter((asset) => asset.kind === "model");
  const symbols = supported.filter((asset) => asset.kind === "symbol");
  const datasheets = supported.filter((asset) => asset.kind === "datasheet");
  if ((footprints.length || models.length) && !metadata.packageName.trim()) {
    throw new Error("A package / footprint suffix is required when a footprint or 3D model is included.");
  }
  const packageStem = sanitizeKiCadName(metadata.packageName, "Package");
  const footprintNames = footprints.map((asset, index) => {
    if (footprints.length === 1) return `${partName}_${packageStem}`;
    const original = firstFootprintName(textDecoder.decode(asset.bytes)) || `Footprint_${index + 1}`;
    return `${partName}_${sanitizeKiCadName(original)}`;
  });
  const modelNames = models.map((asset, index) => {
    const ext = extension(asset.name) || ".step";
    const stem =
      models.length === 1
        ? footprintNames[0] ?? `${partName}_${packageStem}`
        : `${footprintNames[0] ?? `${partName}_${packageStem}`}_${sanitizeKiCadName(
            basename(asset.name).slice(0, -ext.length),
            `Model_${index + 1}`,
          )}`;
    return `${stem}${ext}`;
  });
  const primaryFootprint = footprintNames[0] ? `${category}:${footprintNames[0]}` : "";
  const normalized: NormalizedAsset[] = [];
  const warnings = assets.flatMap((asset) => asset.warnings);

  for (const [index, asset] of symbols.entries()) {
    const rewritten = rewriteSymbolLibrary(
      textDecoder.decode(asset.bytes),
      index === 0 ? partName : `${partName}_${index + 1}`,
      primaryFootprint,
      metadata,
    );
    if (rewritten.symbolCount > 1) {
      warnings.push(`${asset.name} contains ${rewritten.symbolCount} top-level symbols; each was namespaced under ${partName}.`);
    }
    normalized.push({
      id: asset.id,
      kind: "symbol",
      inputName: asset.sourceName,
      outputPath: `symbols/${category}.kicad_sym`,
      bytes: textEncoder.encode(rewritten.source),
      strategy: "merge-symbol-library",
      notes: [`Symbol name: ${index === 0 ? partName : `${partName}_${index + 1}`}`],
    });
  }

  for (const [index, asset] of footprints.entries()) {
    const modelReference = modelNames[index] ?? modelNames[0];
    const repositoryModelPath = modelReference
      ? `\${MY_KICAD_LIB}/3dmodels/${category}.3dshapes/${modelReference}`
      : undefined;
    const rewritten = rewriteFootprint(
      textDecoder.decode(asset.bytes),
      footprintNames[index],
      repositoryModelPath,
    );
    normalized.push({
      id: asset.id,
      kind: "footprint",
      inputName: asset.sourceName,
      outputPath: `footprints/${category}.pretty/${footprintNames[index]}.kicad_mod`,
      bytes: textEncoder.encode(rewritten),
      strategy: "replace",
      notes: modelReference ? [`3D reference: ${repositoryModelPath}`] : ["No 3D model linked"],
    });
  }

  for (const [index, asset] of models.entries()) {
    normalized.push({
      id: asset.id,
      kind: "model",
      inputName: asset.sourceName,
      outputPath: `3dmodels/${category}.3dshapes/${modelNames[index]}`,
      bytes: asset.bytes,
      strategy: "replace",
      notes: ["Geometry preserved; filename normalized"],
    });
  }

  const manufacturerDir = sanitizeKiCadName(metadata.manufacturer, "Unknown-Manufacturer");
  for (const [index, asset] of datasheets.entries()) {
    const suffix = datasheets.length > 1 ? `_${index + 1}` : "";
    normalized.push({
      id: asset.id,
      kind: "datasheet",
      inputName: asset.sourceName,
      outputPath: `datasheets/${manufacturerDir}/${partName}${suffix}.pdf`,
      bytes: asset.bytes,
      strategy: "replace",
      notes: ["Local datasheet copy"],
    });
  }

  if (!symbols.length) warnings.push("No modern symbol file is included.");
  if (!footprints.length) warnings.push("No footprint file is included.");
  if (!models.length) warnings.push("No 3D model is included.");
  if (metadata.verified === "Unverified") {
    warnings.push("This import is marked Unverified; check pin numbering and pad dimensions before production use.");
  }

  const replacePaths = normalized
    .filter((file) => file.strategy === "replace")
    .map((file) => file.outputPath);
  const duplicatePath = replacePaths.find((path, index) => replacePaths.indexOf(path) !== index);
  if (duplicatePath) throw new Error(`Multiple assets normalize to the same repository path: ${duplicatePath}`);

  const manifestPath = `metadata/${category}/${partName}.json`;
  const manifestAssets = await Promise.all(
    normalized.map(async (file) => ({
      type: file.kind,
      source_file: file.inputName,
      target_path: file.outputPath,
      sha256: await sha256(file.bytes),
    })),
  );
  const manifest = {
    schema_version: 1,
    component: {
      manufacturer: metadata.manufacturer,
      mpn: metadata.mpn,
      library_name: metadata.libraryName,
      description: metadata.description,
      package: metadata.packageName,
      datasheet: metadata.datasheet,
    },
    library: {
      category,
      symbol: symbols.length ? `${category}:${partName}` : null,
      footprints: footprintNames.map((name) => `${category}:${name}`),
      verified: metadata.verified,
    },
    provenance: {
      source_url: metadata.sourceUrl,
      imported_at: new Date().toISOString(),
      tool: "KiCad Library Intake",
    },
    assets: manifestAssets,
  };
  normalized.push({
    id: randomId(),
    kind: "metadata",
    inputName: "Generated manifest",
    outputPath: manifestPath,
    bytes: textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    strategy: "replace",
    notes: ["Traceability and verification metadata"],
  });

  let completeness = 10;
  if (symbols.length) completeness += 30;
  if (footprints.length) completeness += 30;
  if (models.length) completeness += 20;
  if (metadata.datasheet || datasheets.length) completeness += 10;

  return {
    componentName: [metadata.manufacturer, metadata.libraryName].filter(Boolean).join(" "),
    symbolName: symbols.length ? partName : null,
    footprintNames,
    files: normalized,
    warnings: [...new Set(warnings)],
    completeness,
  };
}
