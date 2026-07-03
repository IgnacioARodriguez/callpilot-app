import type { BuiltPrompt } from "./promptBuilder.ts";

export type ModelProvider = "mock" | "openai" | "ollama";
export type AudioTranscriptionModel = "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "gpt-4o-transcribe-diarize" | "whisper-1";

export const DEFAULT_TRANSCRIPTION_MODEL: AudioTranscriptionModel = "gpt-4o-transcribe";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

const supportedAudioMimeTypes = new Set([
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/mpga",
  "audio/m4a",
  "audio/wav",
  "audio/webm",
  "video/mp4",
]);

export interface GenerateAnswerInput {
  provider: ModelProvider;
  modelName: string;
  prompt: BuiltPrompt;
  apiKey?: string;
  ollamaBaseUrl?: string;
}

export interface GenerateAnswerResult {
  ok: boolean;
  text: string;
  provider: ModelProvider;
  modelName: string;
  error?: string;
}

export interface OllamaModelInfo {
  name: string;
  modifiedAt?: string;
  size?: number;
}

export interface OllamaModelListResult {
  ok: boolean;
  models: OllamaModelInfo[];
  baseUrl: string;
  error?: string;
}

export interface AudioTranscriptionInput {
  provider: "openai";
  modelName?: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  apiKey?: string;
}

export interface AudioTranscriptionResult {
  ok: boolean;
  text: string;
  modelName: string;
  error?: string;
}

export const normalizeTranscriptionModelName = (modelName?: string): string => {
  const normalized = typeof modelName === "string" ? modelName.trim() : "";
  return normalized || DEFAULT_TRANSCRIPTION_MODEL;
};

export const isSupportedAudioMimeType = (mimeType: string): boolean => {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return supportedAudioMimeTypes.has(normalized);
};

export const validateAudioTranscriptionInput = (input: AudioTranscriptionInput): string | undefined => {
  if (input.provider !== "openai") return "unsupported_transcription_provider";
  if (!input.fileName.trim()) return "missing_audio_file_name";
  if (!isSupportedAudioMimeType(input.mimeType)) return "unsupported_audio_type";
  if (!Number.isFinite(input.byteLength) || input.byteLength <= 0) return "empty_audio_file";
  if (input.byteLength > OPENAI_TRANSCRIPTION_MAX_BYTES) return "audio_file_too_large";
  return undefined;
};

export const extractOpenAITranscriptionText = (response: unknown): string => {
  if (typeof response === "string") return response.trim();
  if (response && typeof response === "object" && "text" in response) {
    const text = (response as { text?: unknown }).text;
    if (typeof text === "string") return text.trim();
  }
  return "";
};

export const createMockAnswer = (prompt: BuiltPrompt): string => [
  `Mode: ${prompt.debug.modeId}`,
  "",
  "## Direct answer",
  "Use the current context as evidence and answer in an interview-ready way.",
  "",
  "## Debug",
  `${prompt.debug.includedSections.length} sections included, ${prompt.debug.omittedSections.length} omitted.`,
].join("\n");

export const buildOpenAIResponsesRequest = (prompt: BuiltPrompt, modelName: string) => ({
  model: modelName,
  instructions: prompt.system,
  input: prompt.user,
  store: false,
});

export const normalizeOllamaBaseUrl = (baseUrl?: string): string => {
  const normalized = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
  return normalized || DEFAULT_OLLAMA_BASE_URL;
};

export const buildOllamaChatRequest = (prompt: BuiltPrompt, modelName: string) => ({
  model: modelName.trim() || "llama3.1",
  stream: false,
  messages: [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ],
});

export const extractOllamaModels = (response: unknown): OllamaModelInfo[] => {
  if (!response || typeof response !== "object") return [];
  const models = (response as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((model): OllamaModelInfo | undefined => {
      if (!model || typeof model !== "object") return undefined;
      const value = model as { name?: unknown; model?: unknown; modified_at?: unknown; size?: unknown };
      const name = typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : typeof value.model === "string" && value.model.trim()
          ? value.model.trim()
          : "";
      if (!name) return undefined;
      const result: OllamaModelInfo = {
        name,
      };
      if (typeof value.modified_at === "string") result.modifiedAt = value.modified_at;
      if (typeof value.size === "number") result.size = value.size;
      return result;
    })
    .filter((model): model is OllamaModelInfo => Boolean(model));
};

export const extractOllamaResponseText = (response: unknown): string => {
  if (!response || typeof response !== "object") return "";
  const message = (response as { message?: unknown }).message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content.trim();
  }
  const responseText = (response as { response?: unknown }).response;
  return typeof responseText === "string" ? responseText.trim() : "";
};

export const buildOpenAIImageAnalysisRequest = (
  imageDataUrl: string,
  modelName: string,
  prompt = "Extract the visible text and summarize the screen for a technical interview assistant. Return concise plain text.",
) => ({
  model: modelName,
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: imageDataUrl, detail: "low" },
      ],
    },
  ],
  store: false,
});

export const extractOpenAIResponseText = (response: unknown): string => {
  if (response && typeof response === "object" && "output_text" in response) {
    const outputText = (response as { output_text?: unknown }).output_text;
    if (typeof outputText === "string" && outputText.trim()) return outputText;
  }

  const output = response && typeof response === "object" ? (response as { output?: unknown }).output : undefined;
  if (!Array.isArray(output)) return "";

  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      });
    })
    .filter(Boolean)
    .join("\n")
    .trim();
};
