import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const developmentPreviewMeta = /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const html = await readFile(`${root}/dist/client/index.html`, "utf8");
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /KiCad Library Intake/);
});
