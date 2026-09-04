const supported = /\.(zip|kicad_sym|kicad_mod|step|stp|iges|igs|wrl|pdf|lib|dcm)(?=$|[?#&\s"'])/i;

export function decoded(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function fileExtension(value: string) {
  return decoded(value).match(supported)?.[1]?.toLowerCase() ?? "";
}

export function modelHintExtension(value: string) {
  return value.match(/\b(iges|igs|step|stp|wrl)\b/i)?.[1]?.toLowerCase() ?? "";
}

export function sniffModelExtension(bytes: Uint8Array) {
  const head = new TextDecoder().decode(bytes.subarray(0, 8192));
  if (head.includes("ISO-10303-21")) return "step";
  if (head.trimStart().startsWith("#VRML")) return "wrl";
  // IGES fixed-width records: 72 data columns, section letter, 7-digit sequence.
  if (head.split(/\r?\n/).some((line) => /^S\s*\d+\s*$/.test(line.slice(72, 80)))) return "igs";
  return "";
}
