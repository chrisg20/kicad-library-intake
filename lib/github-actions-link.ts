import { unzipSync } from "fflate";

import type { DirectLinkFile, LinkCandidate, LinkInspection } from "@/lib/browser-link";

type ActionResult =
  | {
      kind: "page";
      sourceUrl: string;
      title: string;
      metadata: LinkInspection["metadata"];
      librarySearch?: LinkInspection["librarySearch"];
      candidates: LinkCandidate[];
    }
  | {
      kind: "file";
      sourceUrl: string;
      filename: string;
      contentType: string;
      assetPath: string;
    }
  | { kind: "error"; message: string };

const textDecoder = new TextDecoder();

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubResponse(url: string, token: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers(token), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { message?: string };
    if (response.status === 403) {
      throw new Error("The token needs Actions: read and write permission for this repository.");
    }
    throw new Error(detail.message || `GitHub returned ${response.status} while running the link fetch.`);
  }
  return response;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export async function inspectLinkWithActions(
  token: string,
  sourceUrl: string,
  suggestedName = "",
): Promise<LinkInspection | DirectLinkFile> {
  const api = "https://api.github.com/repos/chrisg20/kicad-library-intake";
  const requestId = crypto.randomUUID();
  await githubResponse(`${api}/actions/workflows/link-fetch.yml/dispatches`, token, {
    method: "POST",
    body: JSON.stringify({
      ref: "main",
      inputs: {
        source_url: sourceUrl,
        request_id: requestId,
        suggested_name: suggestedName.slice(0, 200),
      },
    }),
  });

  const deadline = Date.now() + 3 * 60 * 1000;
  let artifact: { archive_download_url: string } | undefined;
  while (Date.now() < deadline) {
    await delay(3000);
    const response = await githubResponse(
      `${api}/actions/artifacts?name=${encodeURIComponent(`link-fetch-${requestId}`)}&per_page=1`,
      token,
    );
    const payload = await response.json() as {
      artifacts: Array<{ expired: boolean; archive_download_url: string }>;
    };
    artifact = payload.artifacts.find((item) => !item.expired);
    if (artifact) break;
  }
  if (!artifact) throw new Error("The GitHub fetch job did not finish within three minutes.");

  const archiveResponse = await githubResponse(artifact.archive_download_url, token);
  const files = unzipSync(new Uint8Array(await archiveResponse.arrayBuffer()));
  const resultBytes = files["response.json"];
  if (!resultBytes) throw new Error("The GitHub fetch job returned an invalid result.");
  const result = JSON.parse(textDecoder.decode(resultBytes)) as ActionResult;
  if (result.kind === "error") throw new Error(result.message);
  if (result.kind === "page") return result;
  const asset = files[result.assetPath];
  if (!asset) throw new Error("The fetched file was missing from the GitHub artifact.");
  return { ...result, bytes: asset };
}
