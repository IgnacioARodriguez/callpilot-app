import type { BuiltPrompt } from "./promptBuilder.ts";
import { STRUCTURED_ANSWER_PAYLOAD_JSON_SCHEMA } from "./answerPayload.ts";

export type ModelProvider = "mock" | "openai" | "ollama" | "natively" | "nvidia" | "groq";
export type AudioTranscriptionModel = "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "gpt-4o-transcribe-diarize" | "whisper-1";

export const DEFAULT_TRANSCRIPTION_MODEL: AudioTranscriptionModel = "gpt-4o-transcribe";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_NVIDIA_VISION_MODEL = "meta/llama-3.2-11b-vision-instruct";

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
  requestId?: string;
  structuredOutput?: boolean;
  liveSpokenOutput?: boolean;
  apiKey?: string;
  nativelyApiKey?: string;
  nvidiaApiKey?: string;
  groqApiKey?: string;
  ollamaBaseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface GenerateAnswerResult {
  ok: boolean;
  text: string;
  provider: ModelProvider;
  modelName: string;
  requestId?: string;
  error?: string;
  cancelled?: boolean;
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

export interface ProviderModelInfo {
  name: string;
  ownedBy?: string;
}

export interface ProviderModelListResult {
  ok: boolean;
  models: ProviderModelInfo[];
  baseUrl: string;
  error?: string;
}

export interface AudioTranscriptionInput {
  provider: "openai" | "natively";
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

export interface CodingProblemExtraction {
  problemTitle: string;
  functionSignature: string;
  language: string;
  examples: Array<{ input: string; output: string }>;
  constraints: string[];
  solution: {
    problemDetected: string;
    approach: string;
    code: string;
    complexity: string;
    edgeCases: string[];
    whatToSayOutLoud: string;
  };
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
  if (input.provider !== "openai" && input.provider !== "natively") return "unsupported_transcription_provider";
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

export const buildOpenAIStructuredAnswerRequest = (prompt: BuiltPrompt, modelName: string) => ({
  ...buildOpenAIResponsesRequest(prompt, modelName),
  text: {
    format: {
      type: "json_schema",
      name: STRUCTURED_ANSWER_PAYLOAD_JSON_SCHEMA.name,
      strict: true,
      schema: STRUCTURED_ANSWER_PAYLOAD_JSON_SCHEMA.schema,
    },
  },
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

export const buildOpenAICompatibleChatRequest = (prompt: BuiltPrompt, modelName: string) => ({
  model: modelName.trim() || "default",
  stream: false,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ],
});

export const extractOpenAICompatibleChatText = (response: unknown): string => {
  if (!response || typeof response !== "object") return "";
  const choices = (response as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    const content = choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") return "";
        const message = (choice as { message?: unknown }).message;
        if (message && typeof message === "object") {
          const text = (message as { content?: unknown }).content;
          if (typeof text === "string") return text;
        }
        const text = (choice as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (content) return content;
  }
  const text = (response as { text?: unknown }).text;
  if (typeof text === "string" && text.trim()) return text.trim();
  const outputText = (response as { output_text?: unknown }).output_text;
  return typeof outputText === "string" ? outputText.trim() : "";
};

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

export const extractOpenAICompatibleModels = (response: unknown): ProviderModelInfo[] => {
  if (!response || typeof response !== "object") return [];
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((model): ProviderModelInfo | undefined => {
      if (!model || typeof model !== "object") return undefined;
      const value = model as { id?: unknown; name?: unknown; owned_by?: unknown };
      const name = typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : typeof value.name === "string" && value.name.trim()
          ? value.name.trim()
          : "";
      if (!name) return undefined;
      const result: ProviderModelInfo = { name };
      if (typeof value.owned_by === "string" && value.owned_by.trim()) result.ownedBy = value.owned_by.trim();
      return result;
    })
    .filter((model): model is ProviderModelInfo => Boolean(model));
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
  prompt = [
    "Analyze this screenshot for a live coding interview assistant.",
    "Use the image as the source of truth and return only JSON.",
    "Include fields problemTitle, functionSignature, language, examples, constraints, solution, and visibleTextExact.",
    "Include visibleTextExact as short verbatim snippets of important text that is actually visible in the screenshot.",
    "Do not invent code, errors, test results, or text that is not visible.",
    "Do not write an implementation or code block unless code is visibly present in the screenshot. For problem-statement-only screenshots, describe the approach without code.",
    "If unrelated chat, Slack, calendar, or notification content is visible, do not transcribe or treat that message as part of the technical problem.",
    "If it shows only a problem statement and no code editor content, leave solution.code empty and summarize the approach without presenting code as visible.",
    "If it is not a coding screen, return a concise JSON summary with empty coding fields.",
  ].join(" "),
) => ({
  model: modelName,
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: imageDataUrl, detail: "high" },
      ],
    },
  ],
  store: false,
});

export const buildOpenAICompatibleImageAnalysisRequest = (
  imageDataUrl: string,
  modelName: string,
  prompt = [
    "Analyze this screenshot for a live coding interview assistant.",
    "Use the screenshot image, not OCR text, as the source of truth.",
    "Return only JSON with visibleTextExact, problemTitle, functionSignature, language, examples, constraints, solution, complexity, edgeCases, and spokenAnswer.",
    "visibleTextExact must contain short verbatim snippets of important text that is actually visible in the screenshot.",
    "Do not invent code, errors, test results, or text that is not visible.",
    "Do not write an implementation or code block unless code is visibly present in the screenshot. For problem-statement-only screenshots, describe the approach without code.",
    "If unrelated chat, Slack, calendar, or notification content is visible, do not transcribe or treat that message as part of the technical problem.",
    "If it shows only a problem statement and no code editor content, leave solution.code empty and summarize the approach without presenting code as visible.",
    "If it is not a coding screen, return empty coding fields and a concise summary.",
  ].join(" "),
) => ({
  model: modelName,
  stream: false,
  max_tokens: 700,
  temperature: 0.2,
  response_format: { type: "json_object" },
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
      ],
    },
  ],
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
