import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const requestId = process.env.INPUT_REQUEST_ID || "";
const blobSha = process.env.INPUT_BLOB_SHA || "";
const filename = (process.env.INPUT_FILENAME || "datasheet.pdf").slice(0, 120);
const manufacturer = (process.env.INPUT_MANUFACTURER || "").slice(0, 120);
const mpn = (process.env.INPUT_MPN || "").slice(0, 120);
const lcscId = (process.env.INPUT_LCSC_ID || "").slice(0, 32);
const categoryOptionsRaw = process.env.INPUT_CATEGORY_OPTIONS || "[]";
const repository = process.env.GITHUB_REPOSITORY || "";
const githubToken = process.env.GITHUB_TOKEN || "";
const openAiKey = process.env.OPENAI_API_KEY || "";
const outputDir = process.env.OUTPUT_DIR || "datasheet-description-output";

async function describe() {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Invalid request ID.");
  if (!/^[0-9a-f]{40}$/i.test(blobSha)) throw new Error("Invalid datasheet reference.");
  if (!repository || !githubToken) throw new Error("The workflow cannot read the temporary datasheet.");
  if (!openAiKey) throw new Error("Add an OPENAI_API_KEY repository secret before using AI descriptions.");
  const categoryOptions = JSON.parse(categoryOptionsRaw);
  if (!Array.isArray(categoryOptions) || !categoryOptions.length || categoryOptions.some((item) => !item?.id || !item?.label)) {
    throw new Error("No valid component categories were supplied.");
  }

  const blobResponse = await fetch(`https://api.github.com/repos/${repository}/git/blobs/${blobSha}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!blobResponse.ok) throw new Error(`The temporary datasheet could not be read (${blobResponse.status}).`);
  const blob = await blobResponse.json();
  const base64 = String(blob.content || "").replace(/\s/g, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The uploaded file is not a valid PDF.");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      reasoning: { effort: "low" },
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Read this electronic-component datasheet. Return a concise functional title, a one-sentence technical description, and the best matching category for a KiCad component catalog.\n\nKnown identifiers:\nManufacturer: ${manufacturer || "unknown"}\nMPN: ${mpn || "unknown"}\nLCSC ID: ${lcscId || "unknown"}\n\nAllowed categories (return the id):\n${categoryOptions.map((item) => `${item.id}: ${item.label}`).join("\n")}\n\nThe title must be a plain English technical noun phrase, no more than 80 characters, and should identify what the part does rather than repeat the part number. Do not use Chinese or Japanese characters in the title. The description must be no more than 240 characters and include the main function and the most useful differentiating specifications. Use only facts supported by the datasheet. Do not include marketing language.`,
          },
          { type: "input_file", filename, file_data: `data:application/pdf;base64,${base64}` },
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "component_catalog_text",
          strict: true,
          schema: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 3, maxLength: 80 },
              description: { type: "string", minLength: 10, maxLength: 240 },
              category: { type: "string", enum: categoryOptions.map((item) => item.id) },
            },
            required: ["title", "description", "category"],
            additionalProperties: false,
          },
        },
      },
      max_output_tokens: 1200,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI returned ${response.status}.`);
  if (payload.status === "incomplete") {
    const reason = payload.incomplete_details?.reason || "unknown reason";
    throw new Error(`OpenAI returned an incomplete response (${reason}). Try again.`);
  }
  const outputText = payload.output_text || payload.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI did not return a title and description.");
  const suggestion = JSON.parse(outputText);
  const title = suggestion.title
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (title.length < 3) throw new Error("OpenAI did not return a usable English title.");
  return {
    kind: "suggestion",
    title,
    description: suggestion.description.trim(),
    category: suggestion.category,
  };
}

await mkdir(outputDir, { recursive: true });
let result;
try {
  result = await describe();
} catch (error) {
  result = { kind: "error", message: error instanceof Error ? error.message : "The datasheet could not be described." };
}
await writeFile(path.join(outputDir, "response.json"), JSON.stringify(result, null, 2));
