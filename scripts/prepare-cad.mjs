import { copyFile, mkdir } from "node:fs/promises";
const source = new URL("../node_modules/occt-import-js/", import.meta.url);
const target = new URL("../public/vendor/", import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ["occt-import-js.js", "occt-import-js.wasm"]) {
  await copyFile(new URL("dist/" + name, source), new URL(name, target));
}
await copyFile(new URL("LICENSE.md", source), new URL("occt-LICENSE.md", target));
