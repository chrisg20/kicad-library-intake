import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceUrl = process.env.INPUT_SOURCE_URL || "";
const requestId = process.env.INPUT_REQUEST_ID || "";
const suggestedName = process.env.INPUT_SUGGESTED_NAME || "";
const outputDir = process.env.OUTPUT_DIR || "link-fetch-output";
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

function privateIpv4(address) {
  const [a, b, c] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

function privateIpv6(address) {
  const value = address.toLowerCase();
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
    /^fe[89ab]/.test(value) || value.startsWith("ff") ||
    (value.startsWith("::ffff:") && privateIpv4(value.slice(7)));
}

async function validate(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS links are supported.");
  if (url.username || url.password) throw new Error("Links containing credentials are not supported.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Links using nonstandard ports are not supported.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private or local network addresses are not supported.");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isIP(address) === 4 ? privateIpv4(address) : privateIpv6(address))) {
    throw new Error("Private or local network addresses are not supported.");
  }
  url.hash = "";
  return url;
}

async function fetchSafe(value) {
  let url = await validate(value);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "KiCad-Library-Intake/1.0 (+https://github.com/chrisg20/kicad-library-intake)",
          Accept: "text/html,application/zip,application/pdf,model/*,application/octet-stream;q=0.9,*/*;q=0.8",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The source returned an invalid redirect.");
      url = await validate(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      const error = new Error(`The source returned HTTP ${response.status}.`);
      error.status = response.status;
      error.url = url.toString();
      throw error;
    }
    return { response, url };
  }
  throw new Error("The source redirected too many times.");
}

function isDigikeyProduct(value) {
  try {
    const url = new URL(value);
    return /(^|\.)digikey\.[a-z.]+$/i.test(url.hostname) && /\/products\/detail\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function markdownText(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownField(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdownText(markdown.match(new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*(.*?)\\s*\\|$`, "im"))?.[1] || "");
}

function parseReaderPage(markdown, pageUrl) {
  const candidates = [];
  const seen = new Set();
  for (const match of markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi)) {
    try {
      const url = new URL(match[2]);
      url.protocol = "https:";
      const label = markdownText(match[1]);
      const kind = kindFor(url, label);
      if (kind === "download" || seen.has(url.toString())) continue;
      seen.add(url.toString());
      candidates.push({ name: label || url.pathname.split("/").at(-1), url: url.toString(), kind, filenameHint: label });
    } catch {}
  }
  const mpn = markdownField(markdown, "Manufacturer Product Number") ||
    new URL(pageUrl).pathname.split("/").filter(Boolean).at(-2) || "";
  return {
    kind: "page",
    sourceUrl: pageUrl,
    title: markdownText(markdown.match(/^Title:\s*(.+)$/im)?.[1] || mpn),
    metadata: {
      mpn,
      libraryName: mpn,
      manufacturer: markdownField(markdown, "Manufacturer"),
      description: markdownField(markdown, "Detailed Description") || markdownField(markdown, "Description"),
      datasheet: candidates.find((item) => item.kind === "datasheet")?.url || "",
    },
    candidates,
  };
}

async function fetchDigikeyReader(value) {
  const source = new URL(value);
  source.hash = "";
  const readerUrl = `https://r.jina.ai/http://${source.hostname}${source.pathname}${source.search}`;
  const { response } = await fetchSafe(readerUrl);
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("text/plain") && !type.includes("text/markdown")) {
    throw new Error("DigiKey blocked the request and its public product-data fallback was unavailable.");
  }
  const markdown = new TextDecoder().decode(await readLimited(response, MAX_PAGE_BYTES));
  return parseReaderPage(markdown, source.toString());
}

async function readLimited(response, maximum) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximum) throw new Error("The remote response exceeds the download limit.");
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error("The remote response exceeds the download limit.");
    return bytes;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("The remote response exceeds the download limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function cleanText(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (original, code) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : original;
    }).replace(/\s+/g, " ").trim();
}

function extension(value) {
  try { value = decodeURIComponent(value); } catch {}
  return value.match(/\.(zip|kicad_sym|kicad_mod|step|stp|iges|igs|wrl|pdf|lib|dcm)(?=$|[?#&\s"'])/i)?.[1]?.toLowerCase() || "";
}

function modelHint(value) {
  return value.match(/\b(iges|igs|step|stp|wrl)\b/i)?.[1]?.toLowerCase() || "";
}

function kindFor(url, hint = "") {
  const ext = extension(url.pathname) || [...url.searchParams.values()].map(extension).find(Boolean) ||
    extension(hint) || modelHint(hint) || modelHint(url.search);
  if (ext === "zip") return "archive";
  if (["kicad_sym", "lib"].includes(ext)) return "symbol";
  if (ext === "kicad_mod") return "footprint";
  if (["step", "stp", "iges", "igs", "wrl"].includes(ext)) return "model";
  if (ext === "pdf") return "datasheet";
  return "download";
}

function discover(html, pageUrl) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    try {
      const attributes = match[2];
      const target = attributes.match(/(?:href|data-(?:href|url|download-url))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (!target) continue;
      const href = cleanText(target[1] ?? target[2] ?? target[3]);
      if (!href || href.startsWith("#")) continue;
      const absolute = new URL(href, pageUrl);
      if (!["http:", "https:"].includes(absolute.protocol) || absolute.username || absolute.password) continue;
      absolute.hash = "";
      const label = cleanText(match[3]);
      const hint = [label, ...[...attributes.matchAll(/(?:download|title|aria-label|type)\s*=\s*["']([^"']+)["']/gi)].map((item) => item[1])].join(" ");
      const kind = kindFor(absolute, hint);
      if (kind === "download" && !/download|kicad|symbol|footprint|3d|step|iges|igs|cad model|datasheet/i.test(hint)) continue;
      if (seen.has(absolute.toString())) continue;
      seen.add(absolute.toString());
      const fallback = absolute.pathname.split("/").filter(Boolean).at(-1) || "Download";
      results.push({ name: label || decodeURIComponent(fallback), url: absolute.toString(), kind, filenameHint: hint });
    } catch {}
  }
  return results.sort((a, b) => Number(a.kind === "download") - Number(b.kind === "download")).slice(0, 100);
}

function metadata(html, candidates) {
  const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const description = cleanText(
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)/i)?.[1] || "",
  );
  let product = {};
  for (const script of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(script[1]);
      const values = Array.isArray(parsed) ? parsed : [parsed, ...(parsed?.["@graph"] || [])];
      product = values.find((value) => value?.["@type"] === "Product" || value?.["@type"]?.includes?.("Product")) || product;
    } catch {}
  }
  const nestedName = (value) => typeof value === "string" ? value : value?.name || "";
  const mpn = String(product.mpn || product.sku || "");
  return {
    title,
    metadata: {
      mpn,
      libraryName: mpn,
      manufacturer: nestedName(product.manufacturer) || nestedName(product.brand),
      description: String(product.description || description),
      datasheet: candidates.find((item) => item.kind === "datasheet")?.url || "",
    },
  };
}

function sniff(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 8192));
  if (head.includes("ISO-10303-21")) return "step";
  if (head.trimStart().startsWith("#VRML")) return "wrl";
  if (head.split(/\r?\n/).some((line) => /^S\s*\d+\s*$/.test(line.slice(72, 80)))) return "igs";
  return "";
}

function filename(response, url, bytes) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const basic = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  let name = encoded ? decodeURIComponent(encoded) : basic || url.pathname.split("/").filter(Boolean).at(-1) || "download";
  name = name.replaceAll("\\", "_").replaceAll("/", "_").trim();
  if (extension(name)) return name;
  for (const value of url.searchParams.values()) {
    if (extension(value)) return decodeURIComponent(value).split(/[\\/]/).at(-1).split(/[?#]/)[0];
  }
  const ext = sniff(bytes) || extension(suggestedName) || modelHint(suggestedName) ||
    modelHint(response.headers.get("content-type") || "");
  if (ext) return name.replace(/\.(php|aspx?|cgi)$/i, "") + "." + ext;
  const type = response.headers.get("content-type") || "";
  if (/zip/i.test(type)) return name + ".zip";
  if (/pdf/i.test(type)) return name + ".pdf";
  return name;
}

await mkdir(outputDir, { recursive: true });
let result;
try {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Invalid request ID.");
  let fetched;
  try {
    fetched = await fetchSafe(sourceUrl);
  } catch (error) {
    if (isDigikeyProduct(sourceUrl)) {
      result = await fetchDigikeyReader(sourceUrl);
    } else {
      throw error;
    }
  }
  if (result) {
    // A vendor-specific public metadata fallback already produced the result.
  } else {
  const { response, url } = fetched;
  const type = (response.headers.get("content-type") || "application/octet-stream").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml+xml")) {
    const bytes = await readLimited(response, MAX_PAGE_BYTES);
    const html = new TextDecoder().decode(bytes);
    const candidates = discover(html, url);
    result = { kind: "page", sourceUrl: url.toString(), ...metadata(html, candidates), candidates };
  } else {
    const bytes = await readLimited(response, MAX_FILE_BYTES);
    const name = filename(response, url, bytes).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 180) || "download";
    const assetPath = path.posix.join("asset", name);
    await mkdir(path.join(outputDir, "asset"), { recursive: true });
    await writeFile(path.join(outputDir, assetPath), bytes);
    result = { kind: "file", sourceUrl: url.toString(), filename: name, contentType: type, assetPath };
  }
  }
} catch (error) {
  result = { kind: "error", message: error instanceof Error ? error.message : "The fetch job failed." };
}
await writeFile(path.join(outputDir, "response.json"), JSON.stringify(result, null, 2));
