import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

async function convert() {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Invalid request ID.");
  if (!/^C\d+$/.test(lcscId)) throw new Error("Invalid LCSC component ID.");

  const stage = path.resolve(outputDir, "converted");
  const outputBase = path.join(stage, `LCSC_${lcscId}`);
  await mkdir(stage, { recursive: true });
  await run("easyeda2kicad", ["--full", `--lcsc_id=${lcscId}`, "--output", outputBase]);

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
