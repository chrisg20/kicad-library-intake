import { unzipSync } from "fflate";

type DescriptionResult =
  | { kind: "suggestion"; title: string; description: string }
  | { kind: "error"; message: string };

export type DatasheetSuggestion = {
  title: string;
  description: string;
};

const api = "https://api.github.com/repos/chrisg20/kicad-library-intake";
const textDecoder = new TextDecoder();

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
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
      throw new Error("The token needs Contents and Actions: read and write permission for the intake repository.");
    }
    throw new Error(detail.message || `GitHub returned ${response.status} while describing the datasheet.`);
  }
  return response;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export async function describeDatasheetWithActions(
  token: string,
  input: { bytes: Uint8Array; filename: string; manufacturer: string; mpn: string; lcscId: string },
): Promise<DatasheetSuggestion> {
  if (!input.bytes.length || textDecoder.decode(input.bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("Upload a valid PDF datasheet first.");
  }

  const blobResponse = await githubResponse(`${api}/git/blobs`, token, {
    method: "POST",
    body: JSON.stringify({ content: bytesToBase64(input.bytes), encoding: "base64" }),
  });
  const blob = await blobResponse.json() as { sha?: string };
  if (!blob.sha) throw new Error("GitHub did not return a temporary datasheet reference.");

  const requestId = crypto.randomUUID();
  await githubResponse(`${api}/actions/workflows/datasheet-describe.yml/dispatches`, token, {
    method: "POST",
    body: JSON.stringify({
      ref: "main",
      inputs: {
        request_id: requestId,
        blob_sha: blob.sha,
        filename: input.filename.slice(0, 120),
        manufacturer: input.manufacturer.slice(0, 120),
        mpn: input.mpn.slice(0, 120),
        lcsc_id: input.lcscId.slice(0, 32),
      },
    }),
  });

  const deadline = Date.now() + 3 * 60 * 1000;
  let artifact: { archive_download_url: string } | undefined;
  while (Date.now() < deadline) {
    await delay(3000);
    const response = await githubResponse(
      `${api}/actions/artifacts?name=${encodeURIComponent(`datasheet-description-${requestId}`)}&per_page=1`,
      token,
    );
    const payload = await response.json() as {
      artifacts: Array<{ expired: boolean; archive_download_url: string }>;
    };
    artifact = payload.artifacts.find((item) => !item.expired);
    if (artifact) break;
  }
  if (!artifact) throw new Error("The datasheet description did not finish within three minutes.");

  const archiveResponse = await githubResponse(artifact.archive_download_url, token);
  const files = unzipSync(new Uint8Array(await archiveResponse.arrayBuffer()));
  const resultBytes = files["response.json"];
  if (!resultBytes) throw new Error("The datasheet description returned an invalid result.");
  const result = JSON.parse(textDecoder.decode(resultBytes)) as DescriptionResult;
  if (result.kind === "error") throw new Error(result.message);
  return { title: result.title, description: result.description };
}
