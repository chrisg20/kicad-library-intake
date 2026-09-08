import {
  extractAndRemoveSymbol,
  mergeKicadSymbolLibraries,
  replaceLibraryPrefix,
  type NormalizedAsset,
} from "@/lib/kicad";
import { sanitizeCatalogTitle } from "@/lib/categories";

export type GitHubConfig = {
  owner: string;
  repo: string;
  branch: string;
  token: string;
};

export type RepositoryInfo = {
  fullName: string;
  branch: string;
  private: boolean;
};

export type CatalogManifest = {
  schema_version: number;
  component: {
    manufacturer: string;
    mpn: string;
    library_name: string;
    title?: string;
    description: string;
    package: string;
    datasheet: string;
  };
  library: {
    category: string;
    symbol: string | null;
    footprints: string[];
    default_footprint: string | null;
  };
  provenance: { source_url?: string; imported_at?: string; tool?: string };
  assets: Array<{ type: string; source_file: string; target_path: string; sha256?: string }>;
};

export type CatalogComponent = {
  manifestPath: string;
  manifest: CatalogManifest;
};

export type CatalogMetadataUpdate = Pick<
  CatalogManifest["component"],
  "manufacturer" | "mpn" | "library_name" | "title" | "description" | "package" | "datasheet"
>;

type GitHubError = {
  message?: string;
  documentation_url?: string;
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function parseRepository(value: string) {
  const trimmed = value.trim().replace(/\.git$/, "").replace(/\/$/, "");
  let path = trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") throw new Error("Only github.com repositories are supported.");
    path = url.pathname.replace(/^\//, "");
  } catch (error) {
    if (/^https?:\/\//i.test(trimmed)) throw error;
  }
  const [owner, repo, ...rest] = path.split("/").filter(Boolean);
  if (!owner || !repo || rest.length) throw new Error("Use owner/repository or paste a GitHub repository URL.");
  return { owner, repo };
}

async function githubRequest<T>(config: GitHubConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail: GitHubError = {};
    try {
      detail = (await response.json()) as GitHubError;
    } catch {
      // GitHub occasionally returns an empty body on proxy errors.
    }
    if (response.status === 401) throw new Error("GitHub rejected the token. Check that it is current and scoped to this repository.");
    if (response.status === 403) throw new Error(detail.message || "The token does not have permission for this operation.");
    if (response.status === 404) throw new Error("Repository or branch not found, or the token cannot access it.");
    throw new Error(detail.message || `GitHub returned ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function testRepository(config: GitHubConfig): Promise<RepositoryInfo> {
  if (!config.token) throw new Error("Enter a fine-grained GitHub token.");
  const repository = await githubRequest<{ full_name: string; private: boolean; default_branch: string }>(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`,
  );
  const branch = config.branch || repository.default_branch;
  await githubRequest(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/branches/${encodeURIComponent(branch)}`,
  );
  return { fullName: repository.full_name, private: repository.private, branch };
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fetchExistingFile(config: GitHubConfig, path: string): Promise<Uint8Array | null> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as GitHubError;
    throw new Error(detail.message || `Could not read ${path}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchRepositoryFile(config: GitHubConfig, path: string) {
  const bytes = await fetchExistingFile(config, path);
  if (!bytes) throw new Error(`${path} was not found in the repository.`);
  return bytes;
}

export async function listCatalogComponents(config: GitHubConfig): Promise<CatalogComponent[]> {
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  const branch = await githubRequest<{ commit: { sha: string } }>(
    config,
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(config.branch)}`,
  );
  const tree = await githubRequest<{ tree: Array<{ path: string; type: string }> }>(
    config,
    `/repos/${owner}/${repo}/git/trees/${branch.commit.sha}?recursive=1`,
  );
  const paths = tree.tree
    .filter((entry) => entry.type === "blob" && /^metadata\/[^/]+\/[^/]+\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  const results: CatalogComponent[] = [];
  for (let index = 0; index < paths.length; index += 8) {
    const batch = await Promise.all(paths.slice(index, index + 8).map(async (manifestPath) => {
      const bytes = await fetchExistingFile(config, manifestPath);
      if (!bytes) return null;
      try {
        const manifest = JSON.parse(textDecoder.decode(bytes)) as CatalogManifest;
        if (!manifest.component?.library_name || !manifest.library?.category || !Array.isArray(manifest.assets)) return null;
        return { manifestPath, manifest };
      } catch {
        return null;
      }
    }));
    results.push(...batch.filter((item): item is CatalogComponent => Boolean(item)));
  }
  return results;
}

function categoryPath(path: string, fromCategory: string, toCategory: string) {
  const prefixes = [
    [`footprints/${fromCategory}.pretty/`, `footprints/${toCategory}.pretty/`],
    [`3dmodels/${fromCategory}.3dshapes/`, `3dmodels/${toCategory}.3dshapes/`],
  ];
  for (const [from, to] of prefixes) if (path.startsWith(from)) return `${to}${path.slice(from.length)}`;
  return path;
}

export async function moveCatalogComponent(
  config: GitHubConfig,
  component: CatalogComponent,
  toCategory: string,
) {
  const fromCategory = component.manifest.library.category;
  if (fromCategory === toCategory) throw new Error("Choose a different section.");
  if (!/^[A-Za-z0-9_-]+$/.test(toCategory)) throw new Error("Section names may only contain letters, numbers, hyphens, and underscores.");
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  const refPath = config.branch.split("/").map(encodeURIComponent).join("/");
  const ref = await githubRequest<{ object: { sha: string } }>(config, `/repos/${owner}/${repo}/git/ref/heads/${refPath}`);
  const parentSha = ref.object.sha;
  const parent = await githubRequest<{ tree: { sha: string } }>(config, `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  const writes = new Map<string, Uint8Array>();
  const deletes = new Set<string>();

  for (const asset of component.manifest.assets) {
    if (asset.type === "symbol" || asset.type === "metadata") continue;
    const destination = categoryPath(asset.target_path, fromCategory, toCategory);
    if (destination === asset.target_path) continue;
    const bytes = await fetchRepositoryFile(config, asset.target_path);
    const movedBytes = asset.type === "footprint"
      ? textEncoder.encode(textDecoder.decode(bytes).replaceAll(`${fromCategory}.3dshapes`, `${toCategory}.3dshapes`))
      : bytes;
    writes.set(destination, movedBytes);
    deletes.add(asset.target_path);
  }

  if (component.manifest.library.symbol) {
    const symbolName = component.manifest.library.symbol.split(":").slice(1).join(":");
    const sourcePath = `symbols/${fromCategory}.kicad_sym`;
    const targetPath = `symbols/${toCategory}.kicad_sym`;
    const source = textDecoder.decode(await fetchRepositoryFile(config, sourcePath));
    const { remaining, extracted } = extractAndRemoveSymbol(source, symbolName);
    const targetBytes = await fetchExistingFile(config, targetPath);
    const target = targetBytes ? textDecoder.decode(targetBytes) : null;
    writes.set(sourcePath, textEncoder.encode(remaining));
    writes.set(targetPath, textEncoder.encode(mergeKicadSymbolLibraries(target, [replaceLibraryPrefix(extracted, fromCategory, toCategory)])));
  }

  const manifest = structuredClone(component.manifest);
  manifest.library.category = toCategory;
  manifest.library.symbol = manifest.library.symbol?.replace(`${fromCategory}:`, `${toCategory}:`) ?? null;
  manifest.library.footprints = manifest.library.footprints.map((value) => value.replace(`${fromCategory}:`, `${toCategory}:`));
  manifest.library.default_footprint = manifest.library.default_footprint?.replace(`${fromCategory}:`, `${toCategory}:`) ?? null;
  manifest.assets = manifest.assets.map((asset) => ({
    ...asset,
    target_path: asset.type === "symbol"
      ? `symbols/${toCategory}.kicad_sym`
      : categoryPath(asset.target_path, fromCategory, toCategory),
  }));
  const manifestName = component.manifestPath.split("/").at(-1)!;
  const nextManifestPath = `metadata/${toCategory}/${manifestName}`;
  writes.set(nextManifestPath, textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  deletes.add(component.manifestPath);

  const blobs = await Promise.all([...writes].map(async ([path, bytes]) => {
    const blob = await githubRequest<{ sha: string }>(config, `/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: bytesToBase64(bytes), encoding: "base64" }),
    });
    return { path, sha: blob.sha };
  }));
  const writePaths = new Set(blobs.map((blob) => blob.path));
  const tree = await githubRequest<{ sha: string }>(config, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: [
        ...blobs.map((blob) => ({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha })),
        ...[...deletes].filter((path) => !writePaths.has(path)).map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
      ],
    }),
  });
  const commit = await githubRequest<{ sha: string; html_url: string }>(config, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `Move ${component.manifest.component.library_name} from ${fromCategory} to ${toCategory}`,
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  await githubRequest(config, `/repos/${owner}/${repo}/git/refs/heads/${refPath}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return { sha: commit.sha, shortSha: commit.sha.slice(0, 7), url: commit.html_url };
}

export async function updateCatalogComponentMetadata(
  config: GitHubConfig,
  component: CatalogComponent,
  values: CatalogMetadataUpdate,
) {
  const manifest = structuredClone(component.manifest);
  manifest.component = {
    ...manifest.component,
    manufacturer: values.manufacturer.trim(),
    mpn: values.mpn.trim(),
    library_name: values.library_name.trim(),
    title: sanitizeCatalogTitle(values.title || ""),
    description: values.description.trim(),
    package: values.package.trim(),
    datasheet: values.datasheet.trim(),
  };
  if (!manifest.component.library_name || !manifest.component.mpn) {
    throw new Error("KiCad name and manufacturer part number are required.");
  }
  return commitPackage(
    config,
    [{
      id: `edit-${component.manifestPath}`,
      kind: "metadata",
      inputName: component.manifestPath,
      outputPath: component.manifestPath,
      bytes: textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
      strategy: "replace",
      notes: ["Catalog metadata edit"],
    }],
    `Update ${manifest.component.library_name} catalog details`,
  );
}

async function consolidateFiles(config: GitHubConfig, files: NormalizedAsset[]) {
  const byPath = new Map<string, NormalizedAsset[]>();
  for (const file of files) byPath.set(file.outputPath, [...(byPath.get(file.outputPath) ?? []), file]);
  const consolidated: Array<{ path: string; bytes: Uint8Array }> = [];

  for (const [path, matches] of byPath) {
    const symbolMerges = matches.filter((file) => file.strategy === "merge-symbol-library");
    if (symbolMerges.length) {
      if (symbolMerges.length !== matches.length) throw new Error(`Conflicting write strategies target ${path}.`);
      const existing = await fetchExistingFile(config, path);
      const incoming = symbolMerges.map((file) => textDecoder.decode(file.bytes));
      const merged = mergeKicadSymbolLibraries(existing ? textDecoder.decode(existing) : null, incoming);
      consolidated.push({ path, bytes: textEncoder.encode(merged) });
      continue;
    }
    if (matches.length > 1) throw new Error(`More than one file would overwrite ${path}.`);
    consolidated.push({ path, bytes: matches[0].bytes });
  }
  return consolidated;
}

export async function commitPackage(
  config: GitHubConfig,
  files: NormalizedAsset[],
  message: string,
) {
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  const refPath = config.branch.split("/").map(encodeURIComponent).join("/");
  const ref = await githubRequest<{ object: { sha: string } }>(
    config,
    `/repos/${owner}/${repo}/git/ref/heads/${refPath}`,
  );
  const parentSha = ref.object.sha;
  const parent = await githubRequest<{ tree: { sha: string } }>(
    config,
    `/repos/${owner}/${repo}/git/commits/${parentSha}`,
  );
  const consolidated = await consolidateFiles(config, files);
  const blobs = await Promise.all(
    consolidated.map(async (file) => {
      const blob = await githubRequest<{ sha: string }>(config, `/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: bytesToBase64(file.bytes), encoding: "base64" }),
      });
      return { path: file.path, sha: blob.sha };
    }),
  );
  const tree = await githubRequest<{ sha: string }>(config, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: blobs.map((blob) => ({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha })),
    }),
  });
  const commit = await githubRequest<{ sha: string; html_url: string }>(
    config,
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
    },
  );
  await githubRequest(config, `/repos/${owner}/${repo}/git/refs/heads/${refPath}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    url: commit.html_url,
    filesChanged: consolidated.length,
  };
}
