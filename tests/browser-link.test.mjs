import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalFetch = globalThis.fetch;
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { hmr: false, middlewareMode: true },
});
const { inspectBrowserLink } = await vite.ssrLoadModule("/lib/browser-link.ts");

afterEach(() => { globalThis.fetch = originalFetch; });
after(async () => { await vite.close(); });

test("imports a direct KiCad file entirely in the browser", async () => {
  globalThis.fetch = async () => new Response('(footprint "Original")', { status: 200, headers: { "content-type": "text/plain" } });
  const result = await inspectBrowserLink("https://example.com/Original.kicad_mod");
  assert.equal(result.kind, "file");
  assert.equal(result.filename, "Original.kicad_mod");
  assert.match(new TextDecoder().decode(result.bytes), /footprint/);
});

test("extracts product metadata and downloadable links from a CORS-readable page", async () => {
  globalThis.fetch = async () => new Response(`<html><head><title>ADL5606 RF amplifier</title><script type="application/ld+json">{"@type":"Product","mpn":"ADL5606ARKZ-R7","brand":{"name":"Analog Devices"}}</script></head><body><a href="/cad/ADL5606.zip">Download KiCad CAD</a></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  const result = await inspectBrowserLink("https://example.com/products/adl5606");
  assert.equal(result.kind, "page");
  assert.equal(result.metadata.mpn, "ADL5606ARKZ-R7");
  assert.equal(result.metadata.manufacturer, "Analog Devices");
  assert.equal(result.candidates[0].url, "https://example.com/cad/ADL5606.zip");
});

test("explains the manual-download fallback when CORS blocks a source", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(inspectBrowserLink("https://vendor.example/part"), /download the CAD file yourself/i);
});
