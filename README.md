# KiCad Library Intake

A GitHub Pages intake console for turning uploaded KiCad assets or an LCSC component ID into a consistently named, reviewable Git commit.

## What it does

- accepts modern KiCad symbol libraries (`.kicad_sym`), footprints (`.kicad_mod`), STEP/IGES/VRML models, PDF datasheets, and ZIP packages
- previews symbol and footprint geometry in 2D, PDF datasheets in-browser, and shaded STEP/IGES/VRML surfaces with orbit, pan, and zoom controls

3D CAD tessellation uses [occt-import-js](https://github.com/kovacsv/occt-import-js) (LGPL-2.1) and OpenCascade, with Three.js rendering. The unmodified runtime, WASM and license are copied from the locked npm package during builds. CAD processing stays local in a cancellable worker; no model is uploaded for preview. Curve-only IGES files cannot produce solid surfaces.
- accepts an LCSC `C` ID and converts it into an importable KiCad bundle with [easyeda2kicad 1.0.1](https://github.com/uPesy/easyeda2kicad.py/tree/fff10a38619963d7cb1c57d779655a9ea4572e95) (AGPL-3.0), including symbol, footprint, STEP, and WRL files
- fills manufacturer, MPN, package, and available metadata from the converted LCSC component
- accepts an optional PDF datasheet on the LCSC path, archives it with the component, and can use OpenAI to suggest an editable English functional title, technical description, and one of the 40 library categories
- autocompletes manually entered manufacturers from component manifests already stored in the connected library
- keeps multiple footprint variants with collision-safe names, a selectable symbol default, and explicit per-footprint model assignments
- separates the human-facing library name (for example `ADL5606`) from the exact orderable MPN (`ADL5606ARKZ-R7`)
- rewrites symbol names, value/metadata fields, footprint names, and 3D model references
- previews every target path and warning before writing anything
- merges symbols into the selected category library rather than replacing the whole `.kicad_sym` file
- creates one atomic GitHub commit through the Git Data REST API
- writes a SHA-256 provenance manifest for every imported component
- provides catalog meatball actions for editing component metadata or moving the complete component between library sections

## GitHub token permissions

Use a fine-grained personal access token limited to the target library repository and
chrisg20/kicad-library-intake. It needs **Contents: read and write** on both repositories
and **Actions: read and write** on chrisg20/kicad-library-intake. The token
stays in browser memory and is sent only to api.github.com.

The LCSC converter runs only on demand and deletes returned artifacts after one day.
AI datasheet descriptions also run on demand. Add an Actions repository secret named
`OPENAI_API_KEY` to chrisg20/kicad-library-intake to enable them. The PDF is passed to
OpenAI as a file input; generated text is always editable before it is committed.
The converter retains a datasheet URL when EasyEDA provides one, but does not guess or
scrape a PDF when the source metadata is missing.

## Target repository layout

```text
symbols/
  CG_Resistors.kicad_sym
  CG_RF_Amplifiers.kicad_sym
  ...
footprints/
  CG_Resistors.pretty/
  CG_RF_Amplifiers.pretty/
  ...
3dmodels/
  CG_Resistors.3dshapes/
  CG_RF_Amplifiers.3dshapes/
  ...
datasheets/
metadata/
```

Footprints reference models through `${MY_KICAD_LIB}` so the repository remains portable between computers.

## Naming rules

Given:

```text
Manufacturer: Analog Devices
MPN:          ADL5606ARKZ-R7
Library name: ADL5606
Package:      SOT-89-3
Category:     CG_RF_Amplifiers (shown as “RF Amplifiers” in the intake UI)
```

the package becomes:

```text
CG_RF_Amplifiers:ADL5606
CG_RF_Amplifiers:ADL5606_SOT-89-3
${MY_KICAD_LIB}/3dmodels/CG_RF_Amplifiers.3dshapes/ADL5606_SOT-89-3.step
metadata/CG_RF_Amplifiers/ADL5606.json
```

The intake provides 40 component categories. Their stored KiCad library names all use
the `CG_` prefix and filesystem-safe underscores so they remain grouped together in
KiCad. The intake and catalog display the corresponding clean category labels without
the prefix.

## GitHub access

Use a fine-grained personal access token restricted to the selected repositories with
`Contents: Read and write` for the library and `Actions: Read and write` for this
intake repository. Repository and branch are remembered in local browser storage. The
token is held only in React state and disappears when the tab closes.

The current implementation commits to an existing branch after explicit user review. It intentionally does not force-update a branch.

The repository that hosts this app can be separate from the KiCad library repository it writes to. The app never contains a built-in GitHub credential.

## GitHub Pages deployment

The included workflow builds and publishes the static site whenever `main` is updated.

1. Push this project to a GitHub repository.
2. Open **Settings → Pages** in that repository.
3. Under **Build and deployment**, choose **GitHub Actions** as the source.
4. Run **Deploy to GitHub Pages** from the Actions tab, or push another commit to `main`.

The workflow automatically handles both `username.github.io` repositories and project sites hosted at `username.github.io/repository-name`.

The production output is written to `dist/client`.

## Intake paths

Manual uploads, ZIP extraction, KiCad processing, review, and GitHub commits happen locally in the browser. LCSC conversion runs through the repository's on-demand GitHub Actions workflow.

## Safety boundaries

- browser uploads are capped at 40 MB each
- ZIPs are capped at 200 entries and 80 MB expanded
- legacy `.lib/.dcm` files are identified but blocked from normalization; convert them to `.kicad_sym` in KiCad first

## Development

```bash
npm run install:ci
npm run dev
```

Production validation and static export:

```bash
node --experimental-strip-types tests/kicad-processing.test.ts
npm run build
```
