import type { PartMetadata } from "@/lib/kicad";
import { filenameFromResponse, validateRemoteUrl } from "@/lib/url-safety";

export type LinkCandidate = {
  name: string;
  url: string;
  kind: "archive" | "symbol" | "footprint" | "model" | "datasheet" | "download";
};

export type LinkInspection = {
  kind: "page";
  sourceUrl: string;
  title: string;
  metadata: Partial<PartMetadata>;
  candidates: LinkCandidate[];
};

export type DirectLinkFile = {
  kind: "file";
  filename: string;
  sourceUrl: string;
  contentType: string;
  bytes: Uint8Array;
};

const MAX_REMOTE_BYTES = 30 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

async function browserFetch(input: string) {
  const requestedUrl = validateRemoteUrl(input);
  let response: Response;
  try {
    response = await fetch(requestedUrl, {
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new Error("This site blocks direct browser access. Download the CAD file yourself, then drop it below.");
  }
  if (!response.ok) {
    throw new Error(`The remote site returned ${response.status}. Download the file and drop it below instead.`);
  }
  const finalUrl = validateRemoteUrl(response.url || requestedUrl.toString());
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_REMOTE_BYTES) throw new Error("The remote file exceeds the 30 MB link limit.");
  return { response, finalUrl };
}

async function readResponse(response: Response, maxBytes: number) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("The remote response is too large to import directly.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The remote response is too large to import directly.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function metaContent(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return stripTags(match[1]);
  }
  return "";
}

function findProductJson(html: string) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const objects: Record<string, unknown>[] = [];
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script[1]);
      if (Array.isArray(parsed)) objects.push(...parsed.filter((value) => value && typeof value === "object"));
      else if (parsed && typeof parsed === "object") {
        objects.push(parsed);
        const graph = (parsed as { "@graph"?: unknown[] })["@graph"];
        if (Array.isArray(graph)) objects.push(...(graph.filter((value) => value && typeof value === "object") as Record<string, unknown>[]));
      }
    } catch {
      // Invalid structured data should not prevent the rest of the page scan.
    }
  }
  return objects.find((item) => {
    const type = item["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  });
}

function nestedName(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return String((value as { name: unknown }).name ?? "");
  return "";
}

function candidateKind(url: URL): LinkCandidate["kind"] {
  const path = url.pathname.toLowerCase();
  if (path.endsWith(".zip")) return "archive";
  if (path.endsWith(".kicad_sym") || path.endsWith(".lib")) return "symbol";
  if (path.endsWith(".kicad_mod")) return "footprint";
  if (/\.(step|stp|iges|igs|wrl)$/.test(path)) return "model";
  if (path.endsWith(".pdf")) return "datasheet";
  return "download";
}

function discoverCandidates(html: string, pageUrl: URL): LinkCandidate[] {
  const results: LinkCandidate[] = [];
  const seen = new Set<string>();
  const anchors = html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const anchor of anchors) {
    try {
      const absolute = validateRemoteUrl(new URL(anchor[1], pageUrl).toString());
      const label = stripTags(anchor[2]);
      const kind = candidateKind(absolute);
      const isKnownFile = kind !== "download";
      const looksDownloadable = /download|kicad|symbol|footprint|3d|step|cad model|datasheet/i.test(label);
      if ((!isKnownFile && !looksDownloadable) || seen.has(absolute.toString())) continue;
      seen.add(absolute.toString());
      const fallback = absolute.pathname.split("/").filter(Boolean).at(-1) || label || "Download";
      results.push({ name: label || decodeURIComponent(fallback), url: absolute.toString(), kind });
      if (results.length >= 16) break;
    } catch {
      // Ignore malformed, unsupported, and local links found in the page.
    }
  }
  return results;
}

function filenameWithKnownExtension(response: Response, url: URL, contentType: string) {
  const filename = filenameFromResponse(response, url);
  if (/\.[a-z0-9_]{2,10}$/i.test(filename)) return filename;
  if (/zip/i.test(contentType)) return `${filename}.zip`;
  if (/pdf/i.test(contentType)) return `${filename}.pdf`;
  if (/step/i.test(contentType)) return `${filename}.step`;
  return filename;
}

function looksLikeFile(url: URL, contentType: string) {
  return /\.(zip|kicad_sym|kicad_mod|step|stp|iges|igs|wrl|pdf|lib|dcm)$/i.test(url.pathname) || (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml"));
}

export async function inspectBrowserLink(input: string): Promise<LinkInspection | DirectLinkFile> {
  const { response, finalUrl } = await browserFetch(input);
  const contentType = (response.headers.get("content-type") || "application/octet-stream").toLowerCase();
  if (looksLikeFile(finalUrl, contentType)) {
    return { kind: "file", filename: filenameWithKnownExtension(response, finalUrl, contentType), sourceUrl: finalUrl.toString(), contentType, bytes: await readResponse(response, MAX_REMOTE_BYTES) };
  }
  const html = new TextDecoder().decode(await readResponse(response, MAX_PAGE_BYTES));
  const product = findProductJson(html);
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const mpn = String(product?.mpn ?? product?.sku ?? metaContent(html, "product:retailer_item_id") ?? "");
  const manufacturer = nestedName(product?.manufacturer) || nestedName(product?.brand);
  const description = String(product?.description ?? metaContent(html, "description") ?? metaContent(html, "og:description") ?? "");
  const candidates = discoverCandidates(html, finalUrl);
  const datasheet = candidates.find((candidate) => candidate.kind === "datasheet")?.url ?? "";
  return { kind: "page", sourceUrl: finalUrl.toString(), title, metadata: { mpn, libraryName: mpn, manufacturer, description, datasheet }, candidates };
}

export async function downloadBrowserFile(candidate: Pick<LinkCandidate, "name" | "url">): Promise<DirectLinkFile> {
  const { response, finalUrl } = await browserFetch(candidate.url);
  const contentType = (response.headers.get("content-type") || "application/octet-stream").toLowerCase();
  if (!looksLikeFile(finalUrl, contentType)) throw new Error("This link returned a web page instead of a CAD file. Download the file manually and drop it below.");
  return { kind: "file", filename: filenameWithKnownExtension(response, finalUrl, contentType) || candidate.name, sourceUrl: finalUrl.toString(), contentType, bytes: await readResponse(response, MAX_REMOTE_BYTES) };
}
