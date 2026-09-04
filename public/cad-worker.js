/* global importScripts, occtimportjs */
self.onmessage = async ({ data }) => {
  try {
    importScripts("./vendor/occt-import-js.js");
    const occt = await occtimportjs({
      locateFile: (file) => new URL("./vendor/" + file, self.location.href).href,
    });
    const options = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.3 };
    const result = /\.(iges|igs)$/i.test(data.name)
      ? occt.ReadIgesFile(data.bytes, options)
      : occt.ReadStepFile(data.bytes, options);
    if (!result.success || !result.meshes.some((m) => m.index.array.length)) {
      throw new Error("No surfaces could be meshed. The file may contain only curves or unsupported geometry.");
    }
    self.postMessage({ meshes: result.meshes });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "CAD import failed." });
  }
};
