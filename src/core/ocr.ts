import type { PreferredLanguage } from "./context.ts";

export type OcrLanguage = "eng" | "spa" | "eng+spa";

export interface OcrResult {
  ok: boolean;
  text: string;
  language: OcrLanguage;
  confidence?: number;
  path?: string;
  error?: string;
}

export const normalizeOcrLanguage = (language?: string | PreferredLanguage): OcrLanguage => {
  const normalized = String(language || "").trim().toLowerCase();
  if (normalized === "spanish" || normalized === "spa" || normalized === "es") return "spa";
  if (normalized === "english" || normalized === "eng" || normalized === "en") return "eng";
  if (normalized === "eng+spa" || normalized === "spa+eng" || normalized === "auto") return "eng+spa";
  return "eng";
};

export const cleanOcrText = (text: string): string =>
  text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

export const ocrConfidenceLabel = (confidence?: number): "unknown" | "low" | "medium" | "high" => {
  if (!Number.isFinite(confidence)) return "unknown";
  if ((confidence ?? 0) >= 80) return "high";
  if ((confidence ?? 0) >= 55) return "medium";
  return "low";
};
