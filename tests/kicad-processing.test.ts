import assert from "node:assert/strict";
import { zipSync } from "fflate";

import {
  acceptedFileTypes,
  classifyAsset,
  inferMetadataFromAssets,
  ingestBrowserFiles,
  mergeKicadSymbolLibraries,
  normalizeAssets,
  preferSolidModels,
  repairFootprintModelLink,
  retargetFootprintModelForCategory,
  validateFootprintModelLink,
  type IntakeAsset,
  type PartMetadata,
} from "../lib/kicad.ts";
import { displayCategory, libraryCategories, sanitizeCatalogTitle, sanitizeManufacturerName } from "../lib/categories.ts";
import { parseModelPreview, parsePlanarPreview } from "../lib/kicad-preview.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sourceSymbol = `(kicad_symbol_lib
  (version 20231120)
  (generator kicad_symbol_editor)
  (generator_version 8.0)
  (symbol "OLD_PART"
    (property "Reference" "U"
      (id 0)
      (at 0 0 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Value" "OLD_PART"
      (id 1)
      (at 0 -2.54 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Footprint" "Vendor:OLD_FP"
      (id 2)
      (at 0 0 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "old.pdf"
      (id 3)
      (at 0 0 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (symbol "OLD_PART_1_1"
      (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type background)))
    )
  )
)
`;

const sourceFootprint = `(footprint "OLD_FP"
  (version 20240108)
  (generator pcbnew)
  (layer "F.Cu")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
  (model "\${KICAD8_3DMODEL_DIR}/Package.step"
    (offset (xyz 0 0 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)
`;

const assets: IntakeAsset[] = [
  {
    id: "symbol",
    name: "OLD_PART.kicad_sym",
    sourceName: "OLD_PART.kicad_sym",
    bytes: encoder.encode(sourceSymbol),
    kind: "symbol",
    warnings: [],
  },
  {
    id: "footprint",
    name: "OLD_FP.kicad_mod",
    sourceName: "OLD_FP.kicad_mod",
    bytes: encoder.encode(sourceFootprint),
    kind: "footprint",
    warnings: [],
  },
  {
    id: "model",
    name: "Package.step",
    sourceName: "Package.step",
    bytes: encoder.encode("ISO-10303-21;\nEND-ISO-10303-21;\n"),
    kind: "model",
    warnings: [],
  },
];

const metadata: PartMetadata = {
  manufacturer: "Analog Devices",
  mpn: "ADL5606ARKZ-R7",
  libraryName: "ADL5606",
  title: "RF gain block",
  packageName: "SOT-89-3",
  category: "RF",
  datasheet: "https://example.com/adl5606.pdf",
  description: "RF gain block",
  sourceUrl: "https://example.com/adl5606",
};

assert.equal(libraryCategories.length, 40);
assert.equal(new Set(libraryCategories.map(({ id }) => id)).size, 40);
assert.ok(libraryCategories.every(({ id, label }) => id.startsWith("CG_") && !label.startsWith("CG_")));
assert.equal(displayCategory("CG_RF_Filters_Passives"), "RF Filters & Passives");
assert.equal(sanitizeCatalogTitle("低噪声 Low-noise 発振器 oscillator"), "Low-noise oscillator");
assert.equal(sanitizeCatalogTitle("低噪声発振器"), "");
assert.equal(sanitizeManufacturerName("XDS (深圳芯达微电子)"), "XDS");
assert.equal(sanitizeManufacturerName("Analog Devices (ADI)"), "Analog Devices");
const localizedManufacturer = inferMetadataFromAssets([
  { ...assets[0], bytes: encoder.encode(sourceSymbol.replace('(property "Value" "OLD_PART"', '(property "Manufacturer" "LCSC Electronics (立创商城)")\n    (property "Value" "OLD_PART"')) },
]);
assert.equal(localizedManufacturer.manufacturer, "LCSC Electronics");

const result = await normalizeAssets(assets, metadata);
const resultWithDatasheet = await normalizeAssets([
  ...assets,
  {
    id: "datasheet",
    name: "source.pdf",
    sourceName: "source.pdf",
    bytes: encoder.encode("%PDF-1.7"),
    kind: "datasheet",
    warnings: [],
  },
], metadata);
assert.ok(resultWithDatasheet.files.some((file) => file.outputPath === "datasheets/RF/ADL5606.pdf"));

const variants = await normalizeAssets([
  ...assets,
  { ...assets[1], id: "second-footprint", sourceName: "alternate/OLD_FP.kicad_mod", modelAssetId: "none" },
], { ...metadata, primaryFootprintId: "second-footprint" });
assert.equal(variants.footprintNames.length, 2);
assert.notEqual(variants.footprintNames[0], variants.footprintNames[1]);
assert.match(decoder.decode(variants.files.find((file) => file.kind === "symbol")!.bytes), new RegExp('RF:' + variants.footprintNames[1]));
assert.equal(variants.files.filter((file) => file.kind === "footprint").length, 2);
const namedVariants = await normalizeAssets([
  { ...assets[1], footprintSuffix: "HandSolder", modelAssetId: "model" },
  { ...assets[1], id: "reflow", footprintSuffix: "Reflow", modelAssetId: "none" },
  assets[2],
], metadata);
assert.deepEqual(namedVariants.footprintNames, ["ADL5606_HandSolder", "ADL5606_Reflow"]);
assert.match(decoder.decode(namedVariants.files.find((file) => file.id === "footprint")!.bytes), /CG_KICAD_LIB/);
assert.doesNotMatch(decoder.decode(namedVariants.files.find((file) => file.id === "reflow")!.bytes), /CG_KICAD_LIB/);
assert.equal(classifyAsset("download", encoder.encode("IGES test".padEnd(72) + "S      1\n")), "model");
const extracted = await ingestBrowserFiles([new File([zipSync({
  "models/part.IGES": encoder.encode("IGES test".padEnd(72) + "S      1\n"),
  "models/download": encoder.encode("IGES test".padEnd(72) + "S      1\n"),
  "models/part.wrl": encoder.encode("#VRML V2.0 utf8\n"),
  "hand/part.kicad_mod": encoder.encode(sourceFootprint),
  "reflow/part.kicad_mod": encoder.encode(sourceFootprint),
})], "part.zip")]);
assert.equal(extracted.filter((asset) => asset.kind === "model").length, 2);
assert.equal(extracted.some((asset) => asset.name === "part.wrl"), false);
assert.equal(preferSolidModels([
  { ...assets[2], id: "solid", name: "housing.step" },
  { ...assets[2], id: "vrml", name: "housing.wrl" },
  { ...assets[2], id: "other-vrml", name: "connector.wrl" },
]).some((asset) => asset.name === "housing.wrl"), false);
assert.equal(preferSolidModels([
  { ...assets[2], id: "solid", name: "housing.step" },
  { ...assets[2], id: "other-vrml", name: "connector.wrl" },
]).some((asset) => asset.name === "connector.wrl"), true);
assert.equal(extracted.filter((asset) => asset.kind === "footprint").length, 2);
assert.equal(extracted.find((asset) => asset.sourceName.endsWith("models/download"))?.name, "download.igs");
assert.equal(result.symbolName, "ADL5606");
assert.deepEqual(result.footprintNames, ["ADL5606_SOT-89-3"]);

const symbol = result.files.find((file) => file.kind === "symbol");
assert(symbol);
const rewrittenSymbol = decoder.decode(symbol.bytes);
assert.match(rewrittenSymbol, /\(symbol "ADL5606"/);
assert.match(rewrittenSymbol, /\(symbol "ADL5606_1_1"/);
assert.match(rewrittenSymbol, /\(property "Value" "ADL5606"/);
assert.match(rewrittenSymbol, /\(property "MPN" "ADL5606ARKZ-R7"/);
assert.match(rewrittenSymbol, /\(property "MPN" "ADL5606ARKZ-R7"[\s\S]*?\(id \d+\)/);
assert.match(rewrittenSymbol, /\(property "Footprint" "RF:ADL5606_SOT-89-3"/);
assert.match(rewrittenSymbol, /\(generator kicad_library_intake\)/);

const footprint = result.files.find((file) => file.kind === "footprint");
assert(footprint);
const rewrittenFootprint = decoder.decode(footprint.bytes);
assert.match(rewrittenFootprint, /^\(footprint "ADL5606_SOT-89-3"/);
assert.match(rewrittenFootprint, /\$\{CG_KICAD_LIB\}\/3dmodels\/RF\.3dshapes\/ADL5606_SOT-89-3\.step/);
assert.match(rewrittenFootprint, /\(generator kicad_library_intake\)/);

// 1. LCSC/EasyEDA import with a STEP model links the actual downloaded asset.
const lcscStep = await normalizeAssets([
  { ...assets[1], id: "lcsc-footprint", sourceName: "easyeda/C329267.kicad_mod" },
  { ...assets[2], id: "lcsc-step", name: "C329267.step", sourceName: "easyeda/C329267.step" },
], { ...metadata, category: "CG_RF_Amplifiers" });
const lcscFootprint = decoder.decode(lcscStep.files.find((file) => file.kind === "footprint")!.bytes);
assert.match(lcscFootprint, /\$\{CG_KICAD_LIB\}\/3dmodels\/CG_RF_Amplifiers\.3dshapes\/ADL5606_SOT-89-3\.step/);
assert.equal(lcscStep.modelLinks[0].status, "repaired");

// 2. STEP wins over an equivalent WRL and the WRL is not retained.
const stepAndWrl = await normalizeAssets([
  { ...assets[1], id: "step-wrl-footprint" },
  { ...assets[2], id: "preferred-step", name: "Package.step" },
  { ...assets[2], id: "discarded-wrl", name: "Package.wrl", bytes: encoder.encode("#VRML V2.0 utf8") },
], { ...metadata, category: "CG_RF_Amplifiers" });
assert.equal(stepAndWrl.files.filter((file) => file.kind === "model").length, 1);
assert.match(stepAndWrl.files.find((file) => file.kind === "model")!.outputPath, /\.step$/);

// 3. A manual footprint and STEP upload receive the same automatic link.
const manual = await normalizeAssets([
  { ...assets[1], id: "manual-footprint", sourceName: "manual/connector.kicad_mod" },
  { ...assets[2], id: "manual-step", sourceName: "manual/connector.step" },
], { ...metadata, libraryName: "USB_C_Receptacle", packageName: "USB-C", category: "CG_Connectors" });
assert.equal(manual.modelLinks[0].kicadPath, "${CG_KICAD_LIB}/3dmodels/CG_Connectors.3dshapes/USB_C_Receptacle_USB-C.step");

// 4. Absolute and temporary paths are replaced.
const absolute = sourceFootprint.replace("${KICAD8_3DMODEL_DIR}/Package.step", "C:\\\\Users\\\\Chris\\\\Downloads\\\\Package.step");
const absoluteResult = repairFootprintModelLink(absolute, "3dmodels/CG_Connectors.3dshapes/USB.step", ["Package.step"]);
assert.doesNotMatch(absoluteResult.source, /C:\\\\Users/);
assert.match(absoluteResult.source, /\$\{CG_KICAD_LIB\}\/3dmodels\/CG_Connectors\.3dshapes\/USB\.step/);

// 5. Existing non-default transforms are preserved.
const transformed = sourceFootprint
  .replace("(offset (xyz 0 0 0))", "(offset (xyz 1.25 -2.5 3))")
  .replace("(scale (xyz 1 1 1))", "(scale (xyz 0.5 0.5 0.5))")
  .replace("(rotate (xyz 0 0 0))", "(rotate (xyz 90 0 180))");
const transformedResult = repairFootprintModelLink(transformed, "3dmodels/CG_Connectors.3dshapes/USB.step", ["Package.step"]);
assert.match(transformedResult.source, /\(offset \(xyz 1\.25 -2\.5 3\)\)/);
assert.match(transformedResult.source, /\(scale \(xyz 0\.5 0\.5 0\.5\)\)/);
assert.match(transformedResult.source, /\(rotate \(xyz 90 0 180\)\)/);

// 6. Moving categories retargets the portable path without changing transforms.
const moved = retargetFootprintModelForCategory(
  transformedResult.source,
  ["3dmodels/CG_RF_Amplifiers.3dshapes/USB.step"],
  "CG_RF_Amplifiers",
);
assert.match(moved.source, /CG_RF_Amplifiers\.3dshapes\/USB\.step/);
assert.doesNotMatch(moved.source, /CG_Connectors\.3dshapes/);
assert.match(moved.source, /\(rotate \(xyz 90 0 180\)\)/);

// 7. Renaming after import keeps the footprint, model filename, and link synchronized.
const renamed = await normalizeAssets([
  { ...assets[1], id: "rename-footprint" },
  { ...assets[2], id: "rename-model" },
], { ...metadata, libraryName: "NEW_PART", packageName: "QFN-16", category: "CG_Interface_ICs" });
assert.equal(renamed.footprintNames[0], "NEW_PART_QFN-16");
assert.equal(renamed.modelLinks[0].modelName, "NEW_PART_QFN-16.step");
assert.match(decoder.decode(renamed.files.find((file) => file.kind === "footprint")!.bytes), /NEW_PART_QFN-16\.step/);

// 8. A component without a model remains valid and has no injected model block.
const noModel = await normalizeAssets([{ ...assets[1], id: "no-model" }], { ...metadata, category: "CG_Connectors" });
assert.equal(noModel.modelLinks[0].status, "no-model");
assert.doesNotMatch(decoder.decode(noModel.files.find((file) => file.kind === "footprint")!.bytes), /CG_KICAD_LIB/);

// 9. Reprocessing an already-correct footprint is idempotent and validates cleanly.
const expectedRepoPath = "3dmodels/CG_Connectors.3dshapes/USB.step";
const once = repairFootprintModelLink(sourceFootprint, expectedRepoPath, ["Package.step"]);
const twice = repairFootprintModelLink(once.source, expectedRepoPath, ["Package.step"]);
assert.equal(twice.source, once.source);
assert.equal(twice.changed, false);
assert.equal(validateFootprintModelLink(twice.source, expectedRepoPath, [expectedRepoPath], "CG_Connectors").valid, true);

const existing = sourceSymbol.replaceAll("OLD_PART", "EXISTING");
const merged = mergeKicadSymbolLibraries(existing, [rewrittenSymbol]);
assert.match(merged, /\(symbol "EXISTING"/);
assert.match(merged, /\(symbol "ADL5606"/);
assert.equal((merged.match(/\(kicad_symbol_lib/g) ?? []).length, 1);

assert.match(acceptedFileTypes, /\.iges/);
assert.match(acceptedFileTypes, /\.igs/);
assert.equal(classifyAsset("package.iges"), "model");
assert.equal(classifyAsset("package.igs"), "model");
assert.equal(classifyAsset("datasheet.pdf"), "datasheet");

const symbolPreview = parsePlanarPreview(assets[0]);
assert(symbolPreview.primitives.some((primitive) => primitive.type === "rect"));

const footprintPreview = parsePlanarPreview(assets[1]);
assert(footprintPreview.primitives.some((primitive) => primitive.type === "pad"));

const stepPreview = parseModelPreview({
  name: "sample.step",
  bytes: encoder.encode("ISO-10303-21;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,2.,3.));\nEND-ISO-10303-21;"),
});
assert.equal(stepPreview.format, "STEP");
assert.equal(stepPreview.points.length, 2);

console.log("KiCad normalization checks passed");
