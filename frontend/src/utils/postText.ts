export const POST_TEXT_LIMIT = 300;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("und", { granularity: "grapheme" })
    : null;

export function countPostTextCharacters(text: string): number {
  if (!text) {
    return 0;
  }

  if (segmenter) {
    return Array.from(segmenter.segment(text)).length;
  }

  return Array.from(text).length;
}

export function isWithinPostTextLimit(
  text: string,
  limit: number = POST_TEXT_LIMIT,
): boolean {
  return countPostTextCharacters(text) <= limit;
}

export function truncatePostText(
  text: string,
  limit: number = POST_TEXT_LIMIT,
): string {
  if (isWithinPostTextLimit(text, limit)) {
    return text;
  }

  const segments = segmenter
    ? Array.from(segmenter.segment(text), (segment) => segment.segment)
    : Array.from(text);
  if (segments.length <= limit) {
    return text;
  }

  const head = segments.slice(0, Math.max(0, limit - 3)).join("");
  return `${head}...`;
}
