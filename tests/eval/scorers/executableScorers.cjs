const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PYTHON_LANGUAGES = new Set(["py", "python", "python3"]);

const parsedCodingPayload = (record) => {
  const parsed = record?.parsed_output;
  if (parsed?.kind === "coding") return parsed.payload || {};
  if (parsed?.payload?.solution || parsed?.payload?.patch) return parsed.payload;
  return null;
};

const fencedCodeFromText = (text) => {
  const source = String(text || "");
  const pythonFence = source.match(/```(?:python|py)\s*\r?\n([\s\S]*?)```/i);
  if (pythonFence?.[1]) return pythonFence[1].trim();
  const genericFence = source.match(/```\s*\r?\n([\s\S]*?)```/);
  if (genericFence?.[1]) return genericFence[1].trim();
  return "";
};

const codeFromRecord = (record) => {
  const coding = parsedCodingPayload(record);
  return String(
    coding?.solution?.code
    || coding?.patch?.code
    || fencedCodeFromText(record?.final_rendered_output)
    || record?.final_rendered_output
    || "",
  );
};

const normalizeAssertions = (value) => {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.python === "string") return item.python;
      return "";
    })
    .map((item) => item.trim())
    .filter(Boolean);
};

const pythonCommand = () => process.env.CALLPILOT_PYTHON || process.env.PYTHON || "python";

const buildPythonHarness = ({ code, publicTests, hiddenTests, previousTests, functionName }) => `
import json
import traceback

candidate_code = ${JSON.stringify(code)}
public_tests = ${JSON.stringify(publicTests)}
hidden_tests = ${JSON.stringify(hiddenTests)}
previous_tests = ${JSON.stringify(previousTests)}
function_name = ${JSON.stringify(functionName || "")}

result = {
    "syntax_ok": False,
    "execution_ok": False,
    "public_tests": {"ok": len(public_tests) == 0, "passed": 0, "total": len(public_tests), "failures": []},
    "hidden_tests": {"ok": len(hidden_tests) == 0, "passed": 0, "total": len(hidden_tests), "failures": []},
    "previous_tests": {"ok": len(previous_tests) == 0, "passed": 0, "total": len(previous_tests), "failures": []},
    "return_shape_ok": True,
    "error": "",
}

namespace = {}

def record_failure(group, index, error):
    result[group]["failures"].append({
        "index": index,
        "error": "".join(traceback.format_exception_only(type(error), error)).strip(),
    })

try:
    compiled = compile(candidate_code, "<candidate>", "exec")
    result["syntax_ok"] = True
    exec(compiled, namespace)
    result["execution_ok"] = True
    if function_name:
        result["return_shape_ok"] = callable(namespace.get(function_name))
except SyntaxError as error:
    result["error"] = "".join(traceback.format_exception_only(type(error), error)).strip()
except Exception as error:
    result["error"] = traceback.format_exc(limit=5)

def run_assertions(group, assertions):
    if not result["syntax_ok"] or not result["execution_ok"]:
        return
    for index, assertion in enumerate(assertions, start=1):
        try:
            exec(assertion, namespace)
            result[group]["passed"] += 1
        except Exception as error:
            record_failure(group, index, error)
    result[group]["ok"] = result[group]["passed"] == result[group]["total"]

run_assertions("public_tests", public_tests)
run_assertions("hidden_tests", hidden_tests)
run_assertions("previous_tests", previous_tests)

print("__CALLPILOT_EXEC_RESULT__" + json.dumps(result, sort_keys=True))
`;

const parseHarnessResult = (stdout) => {
  const marker = "__CALLPILOT_EXEC_RESULT__";
  const index = String(stdout || "").lastIndexOf(marker);
  if (index < 0) return null;
  const payload = String(stdout).slice(index + marker.length).trim().split(/\r?\n/)[0];
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

const runPythonExecutableScorer = ({
  code,
  publicTests = [],
  hiddenTests = [],
  previousTests = [],
  functionName = "",
  timeoutMs = 2000,
  cwd = process.cwd(),
} = {}) => {
  if (!String(code || "").trim()) {
    return {
      ok: false,
      skipped: false,
      language: "python",
      syntax_ok: false,
      execution_ok: false,
      timeout: false,
      public_tests_ok: publicTests.length === 0,
      hidden_tests_ok: hiddenTests.length === 0,
      previous_turn_regression_ok: previousTests.length === 0,
      return_shape_ok: !functionName,
      error: "missing_code",
      stdout: "",
      stderr: "",
      duration_ms: 0,
    };
  }

  const started = Date.now();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-exec-scorer-"));
  const scriptPath = path.join(tempDir, "candidate_harness.py");
  fs.writeFileSync(scriptPath, buildPythonHarness({ code, publicTests, hiddenTests, previousTests, functionName }), "utf8");

  const child = spawnSync(pythonCommand(), [scriptPath], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  fs.rmSync(tempDir, { recursive: true, force: true });

  const timeout = child.error?.code === "ETIMEDOUT";
  const harness = parseHarnessResult(child.stdout);
  const spawnError = child.error && !timeout ? child.error.message : "";
  const stderr = String(child.stderr || "");
  const stdout = String(child.stdout || "");

  const syntaxOk = Boolean(harness?.syntax_ok);
  const executionOk = Boolean(harness?.execution_ok);
  const publicOk = Boolean(harness?.public_tests?.ok);
  const hiddenOk = Boolean(harness?.hidden_tests?.ok);
  const previousOk = Boolean(harness?.previous_tests?.ok);
  const returnShapeOk = Boolean(harness?.return_shape_ok);
  const ok = !timeout
    && !spawnError
    && child.status === 0
    && syntaxOk
    && executionOk
    && publicOk
    && hiddenOk
    && previousOk
    && returnShapeOk;

  return {
    ok,
    skipped: false,
    language: "python",
    syntax_ok: syntaxOk,
    execution_ok: executionOk,
    timeout,
    public_tests_ok: publicOk,
    hidden_tests_ok: hiddenOk,
    previous_turn_regression_ok: previousOk,
    return_shape_ok: returnShapeOk,
    public_tests: harness?.public_tests || { ok: publicTests.length === 0, passed: 0, total: publicTests.length, failures: [] },
    hidden_tests: harness?.hidden_tests || { ok: hiddenTests.length === 0, passed: 0, total: hiddenTests.length, failures: [] },
    previous_tests: harness?.previous_tests || { ok: previousTests.length === 0, passed: 0, total: previousTests.length, failures: [] },
    error: String(timeout ? "python_assertions_timeout" : spawnError || harness?.error || stderr).trim().slice(0, 2000),
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
    duration_ms: durationMs,
  };
};

const scoreExecutableRecord = (record, contract = {}) => {
  const language = String(contract.language || contract.runtime || "python").toLowerCase();
  if (!PYTHON_LANGUAGES.has(language)) {
    return {
      ok: false,
      skipped: true,
      language,
      error: `unsupported_language:${language || "unknown"}`,
    };
  }

  const publicTests = normalizeAssertions(contract.public_tests || contract.publicAssertions || contract.assertions);
  const hiddenTests = normalizeAssertions(contract.hidden_tests || contract.hiddenAssertions);
  const previousTests = normalizeAssertions(contract.previous_tests || contract.previousAssertions || contract.regression_tests);
  return runPythonExecutableScorer({
    code: contract.code || codeFromRecord(record),
    publicTests,
    hiddenTests,
    previousTests,
    functionName: contract.function_name || contract.entrypoint || "",
    timeoutMs: Number(contract.timeout_ms || contract.timeoutMs || 2000),
    cwd: contract.cwd || process.cwd(),
  });
};

module.exports = {
  codeFromRecord,
  normalizeAssertions,
  runPythonExecutableScorer,
  scoreExecutableRecord,
};
