import loggerService from "@/logger";
import JSON5 from "json5";
import { jsonrepair } from "jsonrepair";

const CODE_FENCE_REGEX = /^```(?:json)?\s*([\s\S]+?)\s*```$/i;
const BOS_MARKERS = [
  "<｜begin▁of▁sentence｜>",
  "<|begin_of_text|>",
  "<|im_start|>",
  "<|im_end|>",
];

function stripCodeFence(payload: string): string {
  const match = payload.match(CODE_FENCE_REGEX);
  if (match && match[1]) {
    return match[1];
  }
  return payload;
}

function stripBOM(payload: string): string {
  return payload.replace(/^\uFEFF/, "");
}

function removeBosMarkers(payload: string): string {
  return BOS_MARKERS.reduce(
    (acc, marker) => acc.replace(new RegExp(marker, "g"), ""),
    payload,
  );
}

function stripUnaryPlus(payload: string): string {
  return payload.replace(/([:\[,]\s*)\+([0-9]+(?:\.[0-9]+)?)/g, "$1$2");
}

function stripTrailingCommas(payload: string): string {
  return payload.replace(/,\s*([}\]])/g, "$1");
}

function normalizeQuotes(payload: string): string {
  // Convert single-quoted keys/strings to double quotes cautiously.
  return payload.replace(
    /(['"])([^'"\\]*?)\1/g,
    (_match, _quote, inner) => `"${inner.replace(/"/g, '\\"')}"`,
  );
}

function sanitizePayload(payload: string): string {
  let result = payload.trim();
  result = stripCodeFence(result);
  result = stripBOM(result);
  result = removeBosMarkers(result);
  result = stripUnaryPlus(result);
  result = stripTrailingCommas(result);
  return result;
}

function stringifyAndParse(target: unknown): any {
  return JSON.parse(JSON.stringify(target));
}

export function parseStructuredJson(
  raw: string,
  context: string,
): Record<string, unknown> | unknown[] | null {
  if (!raw) {
    return null;
  }

  let sanitized = sanitizePayload(raw);

  // Only normalize quotes if it looks like single-quoted JSON.
  if (/['"]/.test(sanitized) && !/"/.test(sanitized)) {
    sanitized = normalizeQuotes(sanitized);
  }

  try {
    const repaired = jsonrepair(sanitized);
    return JSON.parse(repaired);
  } catch (primaryError) {
    try {
      const parsed = JSON5.parse(sanitized);
      const reserialized = stringifyAndParse(parsed);
      loggerService.logger.debug(
        { context },
        "Structured JSON parsed via JSON5 fallback.",
      );
      return reserialized;
    } catch (fallbackError) {
      const sample = sanitized.slice(0, 800);
      loggerService.logger.warn(
        {
          context,
          primaryError:
            primaryError instanceof Error ? primaryError.message : primaryError,
          fallbackError:
            fallbackError instanceof Error
              ? fallbackError.message
              : fallbackError,
          sample,
        },
        "Failed to parse structured JSON payload.",
      );
      return null;
    }
  }
}
