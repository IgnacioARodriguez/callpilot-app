import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readDatasetJsonl, writeDatasetJsonl } = require("../tests/eval/datasetCases.cjs");
const { generateDatasetMutations } = require("../tests/eval/mutations/datasetMutations.cjs");

const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};

const inputPath = argValue("--input");
if (!inputPath) throw new Error("Pass --input=path/to/development.jsonl");
const mutationIds = argValue("--mutations")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const outPath = path.resolve(argValue("--out", path.join(path.dirname(path.resolve(inputPath)), "dataset.mutated.jsonl")));

const cases = readDatasetJsonl(path.resolve(inputPath));
const mutated = generateDatasetMutations(cases, { mutations: mutationIds });
writeDatasetJsonl(outPath, mutated);

console.log(JSON.stringify({
  input: path.resolve(inputPath),
  output: outPath,
  input_cases: cases.length,
  mutated_cases: mutated.length,
  mutations: mutationIds.length ? mutationIds : "all",
}, null, 2));
