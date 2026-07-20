const { validateEvaluationRecord } = require("../evaluationContract.cjs");

const normalize = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

const outputText = (record) => [
  record?.raw_model_output,
  record?.final_rendered_output,
].filter(Boolean).join("\n");

const includesAny = (text, terms = []) => {
  const normalized = normalize(text);
  return terms.filter((term) => {
    const expected = normalize(term);
    return expected && normalized.includes(expected);
  });
};

const wordCount = (value) => String(value || "").trim().split(/\s+/).filter(Boolean).length;

const parsedCodingPayload = (record) => {
  const parsed = record?.parsed_output;
  if (parsed?.kind === "coding") return parsed.payload || {};
  if (parsed?.payload?.solution || parsed?.payload?.patch) return parsed.payload;
  return null;
};

const codeFromRecord = (record) => {
  const coding = parsedCodingPayload(record);
  return String(coding?.solution?.code || coding?.patch?.code || record?.final_rendered_output || "");
};

const scoreSchema = (record) => validateEvaluationRecord(record).ok;

const scoreResponseType = (record, expectedResponseType) => {
  if (!expectedResponseType) return true;
  const parsed = record?.parsed_output;
  const actual = parsed?.kind === "coding"
    ? parsed?.payload?.responseType
    : parsed?.payload?.intent || parsed?.kind;
  return actual === expectedResponseType;
};

const scoreForbiddenFacts = (record, forbiddenFacts = []) =>
  includesAny(outputText(record), forbiddenFacts).length === 0;

const scoreNoStaleTopic = (record, staleTopics = []) =>
  includesAny(outputText(record), staleTopics).length === 0;

const scoreNoFutureLeakage = (record, futureForbiddenFacts = []) => {
  const snapshot = record?.input_snapshot || {};
  const timestamp = Number(snapshot.video_timestamp_ms ?? snapshot.timestamp_ms);
  const availableUntil = Number(snapshot.available_until_ms ?? snapshot.video_timestamp_ms ?? snapshot.timestamp_ms);
  const timeOk = !Number.isFinite(timestamp) || !Number.isFinite(availableUntil) || availableUntil <= timestamp;
  return timeOk && includesAny(outputText(record), futureForbiddenFacts).length === 0;
};

const scoreLanguage = (record, expectedLanguage) => {
  if (!expectedLanguage || expectedLanguage === "auto") return true;
  const text = normalize(record?.final_rendered_output || record?.raw_model_output || "");
  if (!text) return false;
  const spanishMarkers = /\b(que|como|para|porque|respuesta|usaria|haria|mantener|depende|si|no)\b/.test(text);
  const englishMarkers = /\b(the|that|with|because|would|use|keep|if|not|answer)\b/.test(text);
  if (expectedLanguage === "spanish") return spanishMarkers && !englishMarkers;
  if (expectedLanguage === "english") return englishMarkers && !spanishMarkers;
  return true;
};

const scoreLength = (record, maxWords) => {
  if (!maxWords) return true;
  return wordCount(record?.final_rendered_output || record?.raw_model_output || "") <= maxWords;
};

const scoreFunctionName = (record, expectedFunctionName) => {
  if (!expectedFunctionName) return true;
  const escaped = String(expectedFunctionName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)\\s*(?:def|function|class)\\s+${escaped}\\s*(?:\\(|:)`).test(codeFromRecord(record));
};

const scorePatchPresence = (record, required) => {
  if (!required) return true;
  const coding = parsedCodingPayload(record);
  const patch = coding?.patch;
  return Boolean(patch && patch.kind && patch.kind !== "none" && String(patch.code || "").trim());
};

const scoreRetries = (record, maxRetries = 0) => Number(record?.retry_count || 0) <= maxRetries;

const scoreRepairs = (record, { allowParserRepairs = true, allowSemanticRepairs = false } = {}) => {
  const repairs = Array.isArray(record?.repair_events) ? record.repair_events : [];
  if (!allowSemanticRepairs && repairs.some((event) => event?.semantic)) return false;
  if (!allowParserRepairs && repairs.length > 0) return false;
  return true;
};

const scoreLatency = (record, maxCompleteMs) => {
  if (!maxCompleteMs) return true;
  const complete = Number(record?.latency?.complete_ms ?? record?.latency?.total_ms);
  return Number.isFinite(complete) && complete <= maxCompleteMs;
};

const scoreDeterministicRecord = (record, expectations = {}) => {
  const checks = {
    schema: scoreSchema(record),
    response_type: scoreResponseType(record, expectations.expected_response_type),
    forbidden_facts: scoreForbiddenFacts(record, expectations.forbidden_facts || []),
    language: scoreLanguage(record, expectations.language),
    length: scoreLength(record, expectations.max_words),
    function_name: scoreFunctionName(record, expectations.function_name),
    patch_presence: scorePatchPresence(record, expectations.patch_required),
    no_stale_topic: scoreNoStaleTopic(record, expectations.stale_topics || []),
    no_future_leakage: scoreNoFutureLeakage(record, expectations.future_forbidden_facts || []),
    retries: scoreRetries(record, expectations.max_retries ?? 0),
    repairs: scoreRepairs(record, {
      allowParserRepairs: expectations.allow_parser_repairs !== false,
      allowSemanticRepairs: expectations.allow_semantic_repairs === true,
    }),
    latency: scoreLatency(record, expectations.max_complete_ms),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
  return {
    ok: failed.length === 0,
    checks,
    failed,
  };
};

module.exports = {
  scoreDeterministicRecord,
  scoreForbiddenFacts,
  scoreFunctionName,
  scoreLanguage,
  scoreLatency,
  scoreLength,
  scoreNoFutureLeakage,
  scoreNoStaleTopic,
  scorePatchPresence,
  scoreRepairs,
  scoreResponseType,
  scoreRetries,
  scoreSchema,
};
