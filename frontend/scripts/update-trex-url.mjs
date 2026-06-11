import { readFile, writeFile } from "node:fs/promises";

const [, , trexPath] = process.argv;
const sourceUrl =
  process.env.TABLEAU_AI_PR_AGENT_EXTENSION_SOURCE_URL ??
  process.env.EXTENSION_SOURCE_URL;

if (!trexPath) {
  throw new Error("Usage: node scripts/update-trex-url.mjs <trex-path>");
}

if (!sourceUrl) {
  process.exit(0);
}

const xml = await readFile(trexPath, "utf8");
const updated = xml.replace(/<url>.*?<\/url>/, `<url>${escapeXml(sourceUrl)}</url>`);
await writeFile(trexPath, updated);

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

