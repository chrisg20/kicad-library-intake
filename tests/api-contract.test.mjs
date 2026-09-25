import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("build is configured as a static export", async () => {
  const config = await readFile(`${root}/next.config.ts`, "utf8");
  const hosting = JSON.parse(await readFile(`${root}/.openai/hosting.json`, "utf8"));
  assert.match(config, /output:\s*["']export["']/);
  assert.equal(hosting.static.directory, "dist/client");
  await access(`${root}/dist/client/index.html`);
});

test("GitHub Pages workflow publishes the static client", async () => {
  const workflow = await readFile(`${root}/.github/workflows/pages.yml`, "utf8");
  assert.match(workflow, /actions\/upload-pages-artifact@v5/);
  assert.match(workflow, /path:\s*dist\/client/);
  assert.match(workflow, /actions\/deploy-pages@v5/);
});


test("datasheet AI backend uses the OpenRouter secret and endpoint", async () => {
  const workflow = await readFile(`${root}/.github/workflows/datasheet-describe.yml`, "utf8");
  const script = await readFile(`${root}/scripts/describe-datasheet.mjs`, "utf8");
  assert.match(workflow, /OPENROUTER_API_KEY:\s*\$\{\{\s*secrets\.OPENROUTER_API_KEY\s*\}\}/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/);
  assert.match(script, /https:\/\/openrouter\.ai\/api\/v1\/chat\/completions/);
  assert.match(script, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(script, /api\.openai\.com\/v1\/responses/);
});
