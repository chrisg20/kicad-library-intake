import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const lcscId = (process.env.INPUT_LCSC_ID || "").trim().toUpperCase();
const requestId = process.env.INPUT_REQUEST_ID || "";
const outputDir = process.env.OUTPUT_DIR || "lcsc-convert-output";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}.`)));
  });
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(entryPath));
    else files.push(entryPath);
  }
  return files;
}

function datasheetUrlFromSymbol(source) {
  const match = source.match(/\(property\s+"Datasheet"\s+"((?:\\.|[^"\\])*)"/i);
  if (!match) return "";
  return match[1].replace(/\\([\\"])/g, "$1").trim();
}

function normalizedDatasheetUrl(value) {
  const trimmed = value.trim().replaceAll("&amp;", "&");
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:/i, "https:");
  return trimmed;
}

function embeddedPdfUrl(source) {
  const decoded = source
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replaceAll("&amp;", "&");
  const matches = decoded.match(/https:\/\/datasheet\.lcsc\.com\/[^"'\s<>]+\.pdf(?:\?[^"'\s<>]*)?/gi) || [];
  return matches.find((url) => url.toUpperCase().includes(lcscId)) || matches[0] || "";
}

async function fetchLcscPdf(datasheetUrl) {
  const productUrl = `https://www.lcsc.com/product-detail/${lcscId}.html`;
  const browserHeaders = {
    Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
    Referer: productUrl,
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
  };
  let cookie = "";
  try {
    const productResponse = await fetch(productUrl, { headers: browserHeaders, redirect: "follow" });
    cookie = productResponse.headers.getSetCookie?.().map((value) => value.split(";", 1)[0]).join("; ") || "";
  } catch {
    // The PDF request can still succeed without the product-page cookie.
  }

  const attempts = [
    { ...browserHeaders, ...(cookie ? { Cookie: cookie } : {}) },
    { ...browserHeaders, Referer: "https://www.lcsc.com/" },
  ];
  let lastStatus = 0;
  const pendingUrls = [datasheetUrl];
  const visitedUrls = new Set();
  while (pendingUrls.length) {
    const url = pendingUrls.shift();
    if (!url || visitedUrls.has(url)) continue;
    visitedUrls.add(url);
    for (const headers of attempts) {
      const response = await fetch(url, { redirect: "follow", headers });
      lastStatus = response.status;
      if (!response.ok) continue;
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > 40 * 1024 * 1024) throw new Error("The LCSC datasheet exceeds the 40 MB intake limit.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 40 * 1024 * 1024) throw new Error("The LCSC datasheet exceeds the 40 MB intake limit.");
      const decoded = new TextDecoder().decode(bytes);
      if (decoded.startsWith("%PDF-")) return bytes;
      const embedded = embeddedPdfUrl(decoded);
      if (embedded && !visitedUrls.has(embedded) && !pendingUrls.includes(embedded)) pendingUrls.push(embedded);
    }
  }
  console.warn(`LCSC datasheet download returned HTTP ${lastStatus || "error"}.`);
  return null;
}

async function addDatasheet(stage) {
  const symbolPath = (await filesUnder(stage)).find((file) => file.toLowerCase().endsWith(".kicad_sym"));
  if (!symbolPath) return false;
  const datasheetUrl = normalizedDatasheetUrl(datasheetUrlFromSymbol(await readFile(symbolPath, "utf8")));
  if (!/^https:\/\//i.test(datasheetUrl)) return false;
  const bytes = await fetchLcscPdf(datasheetUrl);
  if (!bytes) return false;
  await writeFile(path.join(stage, `LCSC_${lcscId}_datasheet.pdf`), bytes);
  console.log("Attached LCSC datasheet PDF to the converted bundle.");
  return true;
}

async function convert() {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Invalid request ID.");
  if (!/^C\d+$/.test(lcscId)) throw new Error("Invalid LCSC component ID.");

  const stage = path.resolve(outputDir, "converted");
  const outputBase = path.join(stage, `LCSC_${lcscId}`);
  await mkdir(stage, { recursive: true });
  await run("easyeda2kicad", ["--full", `--lcsc_id=${lcscId}`, "--output", outputBase]);
  await addDatasheet(stage);

  const filename = `LCSC_${lcscId}_easyeda2kicad.zip`;
  const assetPath = path.posix.join("asset", filename);
  await mkdir(path.join(outputDir, "asset"), { recursive: true });
  await run("zip", ["-q", "-r", path.resolve(outputDir, assetPath), "."], { cwd: stage });
  return {
    kind: "file",
    sourceUrl: `https://www.lcsc.com/product-detail/${lcscId}.html`,
    filename,
    contentType: "application/zip",
    assetPath,
  };
}

await mkdir(outputDir, { recursive: true });
let result;
try {
  result = await convert();
} catch (error) {
  result = { kind: "error", message: error instanceof Error ? error.message : "The LCSC conversion failed." };
}
await writeFile(path.join(outputDir, "response.json"), JSON.stringify(result, null, 2));
