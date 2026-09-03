import assert from "node:assert/strict";

import {
  mergeKicadSymbolLibraries,
  normalizeAssets,
  type IntakeAsset,
  type PartMetadata,
} from "../lib/kicad.ts";

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
  packageName: "SOT-89-3",
  category: "RF",
  datasheet: "https://example.com/adl5606.pdf",
  description: "RF gain block",
  verified: "Datasheet checked",
  sourceUrl: "https://example.com/adl5606",
};

const result = await normalizeAssets(assets, metadata);
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
assert.match(rewrittenFootprint, /\$\{MY_KICAD_LIB\}\/3dmodels\/RF\.3dshapes\/ADL5606_SOT-89-3\.step/);
assert.match(rewrittenFootprint, /\(generator kicad_library_intake\)/);

const existing = sourceSymbol.replaceAll("OLD_PART", "EXISTING");
const merged = mergeKicadSymbolLibraries(existing, [rewrittenSymbol]);
assert.match(merged, /\(symbol "EXISTING"/);
assert.match(merged, /\(symbol "ADL5606"/);
assert.equal((merged.match(/\(kicad_symbol_lib/g) ?? []).length, 1);

console.log("KiCad normalization checks passed");
