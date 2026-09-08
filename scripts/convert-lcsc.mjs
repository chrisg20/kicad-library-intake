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

async function addDatasheet(stage) {
  const symbolPath = (await filesUnder(stage)).find((file) => file.toLowerCase().endsWith(".kicad_sym"));
  if (!symbolPath) return false;
  const datasheetUrl = datasheetUrlFromSymbol(await readFile(symbolPath, "utf8"));
  if (!/^https:\/\//i.test(datasheetUrl)) return false;

  const response = await fetch(datasheetUrl, {
    redirect: "follow",
    headers: { "User-Agent": "kicad-library-intake/1.0" },
  });
  if (!response.ok) return false;
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 40 * 1024 * 1024) return false;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 40 * 1024 * 1024 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return false;
  await writeFile(path.join(stage, `LCSC_${lcscId}_datasheet.pdf`), bytes);
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
