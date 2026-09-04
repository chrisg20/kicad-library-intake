# KiCad Library Intake

A static, browser-based intake console for turning downloaded KiCad CAD assets into a consistently named, reviewable Git commit. It is designed to run on GitHub Pages without a backend.

## What it does

- accepts modern KiCad symbol libraries (`.kicad_sym`), footprints (`.kicad_mod`), STEP/IGES/VRML models, PDF datasheets, and ZIP packages
- previews symbol and footprint geometry in 2D, PDF datasheets in-browser, and shaded STEP/IGES/VRML surfaces with orbit, pan, and zoom controls

3D CAD tessellation uses [occt-import-js](https://github.com/kovacsv/occt-import-js) (LGPL-2.1) and OpenCascade, with Three.js rendering. The unmodified runtime, WASM and license are copied from the locked npm package during builds. CAD processing stays local in a cancellable worker; no model is uploaded for preview. Curve-only IGES files cannot produce solid surfaces.
- imports direct CAD links and inspects component pages when the source permits browser cross-origin access
- discovers IGES/IGS links from extensions, encoded/query filenames, labels, and download attributes; detects extensionless IGES content
- keeps multiple footprint variants with collision-safe names, a selectable symbol default, and explicit per-footprint model assignments
- separates the human-facing library name (for example `ADL5606`) from the exact orderable MPN (`ADL5606ARKZ-R7`)
- rewrites symbol names, value/metadata fields, footprint names, and 3D model references
- previews every target path and warning before writing anything
- merges symbols into the selected category library rather than replacing the whole `.kicad_sym` file
- creates one atomic GitHub commit through the Git Data REST API
- writes a SHA-256 provenance manifest for every imported component

## Target repository layout

```text
symbols/
  Custom.kicad_sym
  RF.kicad_sym
  Modules.kicad_sym
footprints/
  Custom.pretty/
  RF.pretty/
  Modules.pretty/
3dmodels/
  Custom.3dshapes/
  RF.3dshapes/
  Modules.3dshapes/
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
Category:     RF
```

the package becomes:

```text
RF:ADL5606
RF:ADL5606_SOT-89-3
${MY_KICAD_LIB}/3dmodels/RF.3dshapes/ADL5606_SOT-89-3.step
metadata/RF/ADL5606.json
```

## GitHub access

Use a fine-grained personal access token restricted to the target repository with `Contents: Read and write`. Repository and branch are remembered in local browser storage. The token is held only in React state and disappears when the tab closes.

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

## Pages-only link behavior

File uploads, ZIP extraction, KiCad processing, review, and GitHub commits all happen locally in the browser. Direct links also work when the remote host allows browser cross-origin requests. Many manufacturer and distributor sites do not; in that case, download the CAD package normally and drop it into the app.

## Safety boundaries

- local/private-network URL targets and nonstandard ports are rejected before a browser request is attempted
- linked downloads are capped at 30 MB
- browser uploads are capped at 40 MB each
- ZIPs are capped at 200 entries and 80 MB expanded
- legacy `.lib/.dcm` files are identified but blocked from normalization; convert them to `.kicad_sym` in KiCad first
- unverified parts receive a visible warning and `Verified: Unverified` metadata

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
