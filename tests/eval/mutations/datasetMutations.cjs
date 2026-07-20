const { validateDatasetCase } = require("../datasetCases.cjs");

const MUTATION_VERSION = "callpilot-eval-mutation-v1";

const TEXT_FIELDS = [
  "available_screen_context",
  "screen_text",
  "raw_visible_text",
  "available_transcript",
  "transcript_text",
  "current_transcript_text",
];

const MUTATIONS = {
  screen_ocr_confusions: {
    description: "Apply common OCR character confusions to screen text.",
    apply(input) {
      return mutateTextFields(input, (text) => text
        .replace(/[oO]/g, "0")
        .replace(/[lI]/g, "1")
        .replace(/\btarget\b/gi, "targct")
        .replace(/\breturn\b/gi, "retum"));
    },
  },
  browser_chrome_noise: {
    description: "Prepend browser and meeting UI text to screen context.",
    apply(input) {
      const noise = [
        "Google Chrome",
        "Share screen",
        "Participants",
        "Chat",
        "Run Code",
        "",
      ].join("\n");
      return mutateTextFields(input, (text) => `${noise}${text}`.trim(), ["available_screen_context", "screen_text", "raw_visible_text"]);
    },
  },
  partial_statement_crop: {
    description: "Crop the visible statement to simulate a partially visible screen.",
    apply(input) {
      return mutateTextFields(input, (text) => {
        const lines = text.split(/\r?\n/);
        if (lines.length <= 2) return text.slice(0, Math.max(1, Math.floor(text.length * 0.75)));
        return lines.slice(0, Math.max(1, Math.ceil(lines.length * 0.75))).join("\n");
      }, ["available_screen_context", "screen_text", "raw_visible_text"]);
    },
  },
  transcript_fillers: {
    description: "Add harmless conversational filler before the actionable transcript.",
    apply(input) {
      const filler = "interviewer: okay, give me one second before the actual question.\n";
      return mutateTextFields(input, (text) => `${filler}${text}`.trim(), ["available_transcript", "transcript_text", "current_transcript_text"]);
    },
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const mutateTextFields = (input, transform, fields = TEXT_FIELDS) => {
  const next = clone(input || {});
  for (const field of fields) {
    if (typeof next[field] === "string" && next[field].trim()) {
      next[field] = transform(next[field]);
    }
  }
  return next;
};

const ensureDevelopmentCase = (datasetCase, { allowExternal = false } = {}) => {
  if (allowExternal) return;
  if (datasetCase?.split !== "development") {
    throw new Error(`Dataset mutations are development-only by default. Refusing to mutate ${datasetCase?.split || "unknown"} case ${datasetCase?.case_id || ""}.`);
  }
};

const mutateDatasetCase = (datasetCase, mutationId, options = {}) => {
  const mutation = MUTATIONS[mutationId];
  if (!mutation) throw new Error(`Unknown dataset mutation: ${mutationId}`);
  ensureDevelopmentCase(datasetCase, options);
  const next = clone(datasetCase);
  next.parent_case_id = datasetCase.case_id;
  next.case_id = `${datasetCase.case_id}#${mutationId}`;
  next.input = mutation.apply(datasetCase.input || {});
  next.mutation = {
    version: MUTATION_VERSION,
    id: mutationId,
    description: mutation.description,
  };
  const validation = validateDatasetCase(next);
  if (!validation.ok) {
    throw new Error(`Mutation ${mutationId} produced invalid dataset case: ${validation.errors.join(", ")}`);
  }
  return next;
};

const generateDatasetMutations = (cases, options = {}) => {
  const mutationIds = Array.isArray(options.mutations) && options.mutations.length > 0
    ? options.mutations
    : Object.keys(MUTATIONS);
  return (cases || []).flatMap((datasetCase) =>
    mutationIds.map((mutationId) => mutateDatasetCase(datasetCase, mutationId, options)));
};

module.exports = {
  MUTATION_VERSION,
  MUTATIONS,
  generateDatasetMutations,
  mutateDatasetCase,
};
