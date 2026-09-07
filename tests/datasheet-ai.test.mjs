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
const { describeDatasheetWithActions } = await vite.ssrLoadModule("/lib/datasheet-ai.ts");

afterEach(() => { globalThis.fetch = originalFetch; });
after(async () => { await vite.close(); });

test("uploads a temporary PDF blob and returns editable catalog text", async () => {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => originalTimeout(callback, 0);
  let requestId = "";
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/git/blobs")) {
      const body = JSON.parse(init.body);
      assert.equal(body.encoding, "base64");
      assert.match(atob(body.content), /^%PDF-/);
      return Response.json({ sha: "a".repeat(40) });
    }
    if (value.endsWith("/actions/workflows/datasheet-describe.yml/dispatches")) {
      const body = JSON.parse(init.body);
      requestId = body.inputs.request_id;
      assert.equal(body.inputs.blob_sha, "a".repeat(40));
      assert.equal(body.inputs.mpn, "CVCO55CL-0800-0980");
      return new Response(null, { status: 204 });
    }
    if (value.includes("/actions/artifacts?")) {
      assert.match(value, new RegExp("datasheet-description-" + requestId));
      return Response.json({ artifacts: [{ expired: false, archive_download_url: "https://api.github.com/description.zip" }] });
    }
    if (value.endsWith("/description.zip")) {
      return new Response(zipSync({
        "response.json": new TextEncoder().encode(JSON.stringify({
          kind: "suggestion",
          title: "800–980 MHz voltage-controlled oscillator",
          description: "Coaxial VCO covering 800–980 MHz with low phase noise.",
        })),
      }));
    }
    throw new Error("Unexpected request: " + value);
  };
  try {
    const suggestion = await describeDatasheetWithActions("token", {
      bytes: new TextEncoder().encode("%PDF-1.7 test"),
      filename: "datasheet.pdf",
      manufacturer: "Crystek",
      mpn: "CVCO55CL-0800-0980",
      lcscId: "C1234",
    });
    assert.equal(suggestion.title, "800–980 MHz voltage-controlled oscillator");
    assert.match(suggestion.description, /VCO/);
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});

test("rejects files that are not PDFs", async () => {
  await assert.rejects(
    describeDatasheetWithActions("token", {
      bytes: new TextEncoder().encode("not a PDF"),
      filename: "notes.txt",
      manufacturer: "",
      mpn: "",
      lcscId: "",
    }),
    /valid PDF/,
  );
});
