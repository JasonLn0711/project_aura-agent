const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+\S+/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [
    /\b(token|password|secret|api[_-]?key)\s*([:=])\s*([^\s,;]+)/gi,
    "$1$2[REDACTED]",
  ],
  [
    /\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*=\s*([^\s,;]+)/gi,
    "$1=[REDACTED]",
  ],
];

const SECRET_KEYS =
  /^(?:authorization|cookie|set-cookie|.*(?:token|password|secret|api[_-]?key).*)$/i;

export function sanitizeForEvent(
  value: unknown,
  outputLimitBytes: number,
  depth = 0,
): unknown {
  return sanitize(value, Math.max(0, outputLimitBytes), depth);
}

function sanitize(
  value: unknown,
  outputLimitBytes: number,
  depth: number,
  key?: string,
): unknown {
  if (key && SECRET_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    let redacted = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, replacement);
    }
    return truncateUtf8(redacted, outputLimitBytes);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 10) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 100)
      .map((item) => sanitize(item, outputLimitBytes, depth + 1));
    if (value.length > 100) items.push("[TRUNCATED]");
    return items;
  }
  const entries = Object.entries(value).slice(0, 100);
  const sanitized = Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      sanitize(item, outputLimitBytes, depth + 1, key),
    ]),
  );
  if (Object.keys(value).length > 100) sanitized.__truncated__ = true;
  return sanitized;
}

function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= limit) return value;
  if (limit === 0) return "";
  const marker = Buffer.from("...[TRUNCATED]");
  if (limit <= marker.byteLength) {
    return marker.subarray(0, limit).toString("ascii");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = limit - marker.byteLength;
  let prefix = "";
  while (end > 0) {
    try {
      prefix = decoder.decode(bytes.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return `${prefix}${marker.toString("ascii")}`;
}
import { TextDecoder } from "node:util";
