import {
  mergeKicadSymbolLibraries,
  type NormalizedAsset,
} from "@/lib/kicad";

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
