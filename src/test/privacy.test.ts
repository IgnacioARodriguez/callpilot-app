import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyShareSafeState,
  assessPrivacyState,
  defaultStealthState,
  normalizeStealthState,
  resetPrivacyState,
  reduceStealthState,
} from "../core/index.ts";

const root = process.cwd();
const readProjectFile = (file: string) => readFileSync(join(root, file), "utf8");

test("private sharing mode is visible locally and on by default", () => {
  assert.equal(defaultStealthState.callPrivacyAllowed, true);
  assert.equal(defaultStealthState.overlayVisible, true);
  assert.equal(defaultStealthState.contentProtectionEnabled, true);
  assert.equal(defaultStealthState.mousePassthroughEnabled, true);
  assert.equal(defaultStealthState.focusMode, "passthrough");
  assert.equal(assessPrivacyState(defaultStealthState, "2026-07-03T00:00:00.000Z").status, "safe");
});

test("revoked privacy mode blocks protected states", () => {
  const notApproved = reduceStealthState(defaultStealthState, { type: "set_call_privacy_allowed", allowed: false });
  const requestedHidden = reduceStealthState(notApproved, { type: "set_overlay_visible", visible: false });
  const requestedCaptureBlock = reduceStealthState(notApproved, { type: "set_content_protection", enabled: true });
  const requestedPassthrough = reduceStealthState(notApproved, { type: "set_mouse_passthrough", enabled: true });

  assert.equal(requestedHidden.overlayVisible, true);
  assert.equal(requestedCaptureBlock.contentProtectionEnabled, false);
  assert.equal(requestedPassthrough.mousePassthroughEnabled, false);
  assert.equal(requestedPassthrough.focusMode, "interactive");
});

test("approved privacy mode permits local privacy controls", () => {
  const approved = reduceStealthState(defaultStealthState, { type: "set_call_privacy_allowed", allowed: true });
  const hidden = reduceStealthState(approved, { type: "set_overlay_visible", visible: false });
  const protectedState = reduceStealthState(hidden, { type: "set_content_protection", enabled: true });
  const passthrough = reduceStealthState(protectedState, { type: "set_mouse_passthrough", enabled: true });

  assert.equal(passthrough.callPrivacyAllowed, true);
  assert.equal(passthrough.overlayVisible, false);
  assert.equal(passthrough.contentProtectionEnabled, true);
  assert.equal(passthrough.mousePassthroughEnabled, true);
  assert.equal(passthrough.focusMode, "passthrough");
});

test("share safe applies visible private sharing posture", () => {
  const shareSafe = applyShareSafeState(defaultStealthState);

  assert.equal(shareSafe.callPrivacyAllowed, true);
  assert.equal(shareSafe.overlayVisible, true);
  assert.equal(shareSafe.contentProtectionEnabled, true);
  assert.equal(shareSafe.mousePassthroughEnabled, true);
  assert.equal(shareSafe.focusMode, "passthrough");
  assert.equal(assessPrivacyState(shareSafe, "2026-07-03T00:00:00.000Z").status, "safe");
});

test("privacy reset restores visible private sharing defaults", () => {
  const hidden = reduceStealthState(defaultStealthState, { type: "set_overlay_visible", visible: false });
  const reset = reduceStealthState(hidden, { type: "reset_privacy" });

  assert.deepEqual(reset, defaultStealthState);
  assert.deepEqual(resetPrivacyState(), defaultStealthState);
  assert.equal(assessPrivacyState(reset, "2026-07-03T00:00:00.000Z").status, "safe");
});

test("revoking approval immediately restores visible interactive state", () => {
  const approved = reduceStealthState(defaultStealthState, { type: "set_call_privacy_allowed", allowed: true });
  const sensitive = normalizeStealthState({
    ...approved,
    overlayVisible: false,
    contentProtectionEnabled: true,
    mousePassthroughEnabled: true,
    focusMode: "passthrough",
  });
  const revoked = reduceStealthState(sensitive, { type: "set_call_privacy_allowed", allowed: false });

  assert.equal(revoked.callPrivacyAllowed, false);
  assert.equal(revoked.overlayVisible, true);
  assert.equal(revoked.contentProtectionEnabled, false);
  assert.equal(revoked.mousePassthroughEnabled, false);
  assert.equal(revoked.focusMode, "interactive");
});

test("desktop bridge exposes explicit call approval IPC", () => {
  const preload = readProjectFile("electron/preload.cjs");
  const desktopTypes = readProjectFile("src/desktop.d.ts");

  assert.match(preload, /setCallPrivacyAllowed/);
  assert.match(preload, /applyShareSafe/);
  assert.match(preload, /resetPrivacy/);
  assert.match(preload, /runPrivacyCheck/);
  assert.match(preload, /stealth:set-call-privacy-allowed/);
  assert.match(preload, /stealth:apply-share-safe/);
  assert.match(preload, /stealth:reset-privacy/);
  assert.match(preload, /privacy:check/);
  assert.match(desktopTypes, /setCallPrivacyAllowed: \(allowed: boolean\) => Promise<StealthState>/);
  assert.match(desktopTypes, /applyShareSafe: \(\) => Promise<StealthState>/);
  assert.match(desktopTypes, /runPrivacyCheck: \(\) => Promise<PrivacyCheckResult>/);
});

test("Electron privacy controls are gated by callPrivacyAllowed", () => {
  const main = readProjectFile("electron/main.cjs");

  assert.match(main, /callPrivacyAllowed:\s*true/);
  assert.match(main, /stealth:set-call-privacy-allowed/);
  assert.match(main, /stealth:apply-share-safe/);
  assert.match(main, /stealth:reset-privacy/);
  assert.match(main, /privacy:check/);
  assert.match(main, /CommandOrControl\+Alt\+R/);
  assert.match(main, /setContentProtection\(Boolean\(stealthState\.contentProtectionEnabled\)\)/);
  assert.match(main, /const sessionPassthroughEnabled = Boolean\(stealthState\.mousePassthroughEnabled && activeSessionTrace\)/);
  assert.match(main, /setIgnoreMouseEvents\(windowRef !== mainWindow && sessionPassthroughEnabled/);
  assert.match(main, /stealthState\.overlayVisible\s*=\s*stealthState\.callPrivacyAllowed\s*\?\s*Boolean\(visible\)\s*:\s*true/);
  assert.match(main, /stealthState\.contentProtectionEnabled\s*=\s*stealthState\.callPrivacyAllowed\s*\?\s*Boolean\(enabled\)\s*:\s*false/);
  assert.match(main, /stealthState\.mousePassthroughEnabled\s*=\s*stealthState\.callPrivacyAllowed\s*\?\s*Boolean\(enabled\)\s*:\s*false/);
});

test("platform privacy QA matrix covers consented video-call checks only", () => {
  const matrix = JSON.parse(readProjectFile("tests/privacy/platform-privacy-matrix.json"));
  const platformIds = matrix.platforms.map((platform: { id: string }) => platform.id);
  const stateIds = matrix.states.map((state: { id: string }) => state.id);

  assert.equal(matrix.requiredConsent, true);
  assert.deepEqual(platformIds, ["google_meet", "zoom", "microsoft_teams"]);
  assert.deepEqual(stateIds, ["not_approved", "approved_visible_protected", "approved_hidden"]);
  assert.ok(matrix.platforms.every((platform: { requiredObserver: boolean }) => platform.requiredObserver));
  assert.ok(matrix.blockedUseCases.some((item: string) => /LeetCode/i.test(item)));
  assert.ok(matrix.blockedUseCases.some((item: string) => /Bypassing/i.test(item)));
});

test("platform privacy QA guide defines observer-based pass and fail criteria", () => {
  const guide = readProjectFile("tests/privacy/platform-privacy-qa.md");

  assert.match(guide, /Everyone in the call knows CallPilot is being tested/);
  assert.match(guide, /Google Meet/);
  assert.match(guide, /Zoom/);
  assert.match(guide, /Microsoft Teams/);
  assert.match(guide, /Pass: observer cannot/);
  assert.match(guide, /Fail: observer can/);
  assert.match(guide, /Out Of Scope/);
  assert.match(guide, /LeetCode or similar anti-cheat\/proctoring detection checks/);
});
