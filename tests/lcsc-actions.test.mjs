import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalFetch = globalThis.fetch;
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { hmr: false, middlewareMode: true },
});
const { convertLcscWithActions, normalizeLcscId } = await vite.ssrLoadModule("/lib/lcsc-actions.ts");

afterEach(() => { globalThis.fetch = originalFetch; });
after(async () => { await vite.close(); });

test("normalizes and validates LCSC component IDs", () => {
  assert.equal(normalizeLcscId(" c2040 "), "C2040");
  assert.throws(() => normalizeLcscId("2040"), /C2040/);
  assert.throws(() => normalizeLcscId("C20-40"), /C2040/);
});

test("dispatches the LCSC workflow and returns its converted bundle", async () => {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => originalTimeout(callback, 0);
  let requestId = "";
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/actions/workflows/lcsc-convert.yml/dispatches")) {
      const body = JSON.parse(init.body);
      requestId = body.inputs.request_id;
      assert.equal(body.inputs.lcsc_id, "C2040");
      return new Response(null, { status: 204 });
    }
    if (value.includes("/actions/artifacts?")) {
      assert.match(value, new RegExp("lcsc-convert-" + requestId));
      return Response.json({ artifacts: [{ expired: false, archive_download_url: "https://api.github.com/artifact.zip" }] });
    }
    if (value.endsWith("/artifact.zip")) {
      return new Response(zipSync({
        "response.json": new TextEncoder().encode(JSON.stringify({
          kind: "file",
          sourceUrl: "https://www.lcsc.com/product-detail/C2040.html",
          filename: "LCSC_C2040_easyeda2kicad.zip",
          contentType: "application/zip",
          assetPath: "asset/LCSC_C2040_easyeda2kicad.zip",
        })),
        "asset/LCSC_C2040_easyeda2kicad.zip": new TextEncoder().encode("converted"),
      }));
    }
    throw new Error("Unexpected request: " + value);
  };
  try {
    const result = await convertLcscWithActions("token", "c2040");
    assert.equal(result.filename, "LCSC_C2040_easyeda2kicad.zip");
    assert.equal(new TextDecoder().decode(result.bytes), "converted");
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});
