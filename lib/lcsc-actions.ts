import { unzipSync } from "fflate";

type ConversionResult =
  | {
      kind: "file";
      sourceUrl: string;
      filename: string;
      contentType: string;
      assetPath: string;
    }
  | { kind: "error"; message: string };

export type LcscConversionFile = {
  filename: string;
  sourceUrl: string;
  contentType: string;
  bytes: Uint8Array;
};

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
    throw new Error(detail.message || `GitHub returned ${response.status} while converting the LCSC part.`);
  }
  return response;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export function normalizeLcscId(value: string) {
  const id = value.trim().toUpperCase();
  if (!/^C\d+$/.test(id)) throw new Error("Enter an LCSC component ID such as C2040.");
  return id;
}

export async function convertLcscWithActions(token: string, value: string): Promise<LcscConversionFile> {
  const lcscId = normalizeLcscId(value);
  const api = "https://api.github.com/repos/chrisg20/kicad-library-intake";
  const requestId = crypto.randomUUID();
  await githubResponse(`${api}/actions/workflows/lcsc-convert.yml/dispatches`, token, {
    method: "POST",
    body: JSON.stringify({
      ref: "main",
      inputs: { lcsc_id: lcscId, request_id: requestId },
    }),
  });

  const deadline = Date.now() + 3 * 60 * 1000;
  let artifact: { archive_download_url: string } | undefined;
  while (Date.now() < deadline) {
    await delay(3000);
    const response = await githubResponse(
      `${api}/actions/artifacts?name=${encodeURIComponent(`lcsc-convert-${requestId}`)}&per_page=1`,
      token,
    );
    const payload = await response.json() as {
      artifacts: Array<{ expired: boolean; archive_download_url: string }>;
    };
    artifact = payload.artifacts.find((item) => !item.expired);
    if (artifact) break;
  }
  if (!artifact) throw new Error("The LCSC conversion did not finish within three minutes.");

  const archiveResponse = await githubResponse(artifact.archive_download_url, token);
  const files = unzipSync(new Uint8Array(await archiveResponse.arrayBuffer()));
  const resultBytes = files["response.json"];
  if (!resultBytes) throw new Error("The LCSC conversion returned an invalid result.");
  const result = JSON.parse(textDecoder.decode(resultBytes)) as ConversionResult;
  if (result.kind === "error") throw new Error(result.message);
  const asset = files[result.assetPath];
  if (!asset) throw new Error("The converted KiCad bundle was missing from the result.");
  return { ...result, bytes: asset };
}
