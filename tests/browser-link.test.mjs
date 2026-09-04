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
const { inspectBrowserLink, downloadBrowserFile } = await vite.ssrLoadModule("/lib/browser-link.ts");

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

test("finds IGES labels, query filenames, encoded extensions, and data-download buttons", async () => {
  globalThis.fetch = async () => new Response(`<html>
    ${Array.from({length:20}, (_,i) => '<a href="/generic/'+i+'">Download</a>').join("")}
    <a href="/cad/PART.IGES">CAD</a>
    <a href="/download?file=part%2Eigs&amp;id=42">File</a>
    <a href="/export/123">IGES</a>
    <button data-download-url="/export/456" title="IGS">Model</button>
    <a href=/part%2EIGS>File</a>
    <a href="javascript:alert(1)">IGES</a>
    </html>`, {headers:{"content-type":"text/html"}});
  const result = await inspectBrowserLink("https://example.com/part");
  const models = result.candidates.filter((c) => c.kind === "model");
  assert.equal(models.length,5);
  assert.equal(result.candidates[0].kind,"model");
  assert.equal(models[1].url,"https://example.com/download?file=part%2Eigs&id=42");
});

test("names extensionless IGES downloads from content, MIME, hints, or query filenames", async () => {
  const iges = "IGES test".padEnd(72) + "S      1\n";
  globalThis.fetch = async () => new Response(iges, {headers:{"content-type":"application/octet-stream"}});
  assert.equal((await inspectBrowserLink("https://example.com/download.php")).filename,"download.igs");
  assert.equal((await inspectBrowserLink("https://example.com/download?file=Model.IGES")).filename,"Model.IGES");
  globalThis.fetch = async () => new Response("model", {headers:{"content-type":"model/iges"}});
  assert.equal((await inspectBrowserLink("https://example.com/export")).filename,"export.iges");
  globalThis.fetch = async () => new Response("model", {headers:{"content-type":"application/octet-stream"}});
  assert.equal((await downloadBrowserFile({name:"IGS",url:"https://example.com/export"})).filename,"export.igs");
});

test("rejects a login page returned by an IGES download URL", async () => {
  globalThis.fetch = async () => new Response("<html>Sign in</html>", {headers:{"content-type":"text/html"}});
  await assert.rejects(downloadBrowserFile({name:"IGES",url:"https://example.com/model.igs"}), /web page/);
});
