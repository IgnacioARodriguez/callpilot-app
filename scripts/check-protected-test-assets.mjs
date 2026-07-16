import { execFileSync } from "node:child_process";

const protectedPrefixes = [
  "tests/fixtures/",
  "tests/rubrics/",
  "tests/baselines/",
];

const allow = process.env.ALLOW_PROTECTED_TEST_ASSET_CHANGES === "1";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const changedTracked = git("diff", "--name-only", "--", ...protectedPrefixes).split(/\r?\n/).filter(Boolean);
const staged = git("diff", "--cached", "--name-only", "--", ...protectedPrefixes).split(/\r?\n/).filter(Boolean);
const untracked = git("ls-files", "--others", "--exclude-standard", "--", ...protectedPrefixes).split(/\r?\n/).filter(Boolean);
const changed = [...new Set([...changedTracked, ...staged, ...untracked])].sort();

if (changed.length > 0 && !allow) {
  console.error("Protected test assets changed without explicit approval:");
  for (const file of changed) console.error(`- ${file}`);
  console.error("");
  console.error("Set ALLOW_PROTECTED_TEST_ASSET_CHANGES=1 only for a human-approved fixture/rubric/baseline update.");
  process.exit(1);
}

console.log(changed.length === 0
  ? "Protected test assets unchanged."
  : `Protected test asset update approved for ${changed.length} file(s).`);
