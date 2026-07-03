export type FocusMode = "interactive" | "non_activating" | "passthrough";
export type PrivacyCheckStatus = "safe" | "risk" | "unknown";

export interface PrivacyCheckResult {
  status: PrivacyCheckStatus;
  summary: string;
  findings: string[];
  checkedAt: string;
}

export interface StealthState {
  callPrivacyAllowed: boolean;
  overlayVisible: boolean;
  contentProtectionEnabled: boolean;
  mousePassthroughEnabled: boolean;
  focusMode: FocusMode;
  shortcutLayerActive: boolean;
}

export type StealthAction =
  | { type: "set_call_privacy_allowed"; allowed: boolean }
  | { type: "set_overlay_visible"; visible: boolean }
  | { type: "set_content_protection"; enabled: boolean }
  | { type: "set_mouse_passthrough"; enabled: boolean }
  | { type: "set_focus_mode"; focusMode: FocusMode }
  | { type: "set_shortcut_layer"; enabled: boolean }
  | { type: "apply_share_safe" }
  | { type: "reset_privacy" }
  | { type: "reset" };

export const defaultStealthState: StealthState = {
  callPrivacyAllowed: false,
  overlayVisible: true,
  contentProtectionEnabled: false,
  mousePassthroughEnabled: false,
  focusMode: "interactive",
  shortcutLayerActive: true,
};

export const normalizeStealthState = (state: StealthState): StealthState => {
  if (!state.callPrivacyAllowed) {
    return {
      ...state,
      overlayVisible: true,
      contentProtectionEnabled: false,
      mousePassthroughEnabled: false,
      focusMode: "interactive",
    };
  }
  if (state.focusMode === "passthrough") {
    return { ...state, mousePassthroughEnabled: true };
  }
  if (state.mousePassthroughEnabled) {
    return { ...state, focusMode: "passthrough" };
  }
  return { ...state };
};

export const resetStealthState = (): StealthState => ({ ...defaultStealthState });

export const applyShareSafeState = (state: StealthState = defaultStealthState): StealthState =>
  normalizeStealthState({
    ...state,
    callPrivacyAllowed: true,
    overlayVisible: false,
    contentProtectionEnabled: true,
    mousePassthroughEnabled: true,
    focusMode: "passthrough",
  });

export const resetPrivacyState = (): StealthState => resetStealthState();

export const assessPrivacyState = (
  state: StealthState,
  checkedAt = new Date().toISOString(),
): PrivacyCheckResult => {
  const normalized = normalizeStealthState(state);
  const findings: string[] = [];

  if (!normalized.callPrivacyAllowed) {
    findings.push("Call privacy approval is off, so privacy controls are unavailable.");
    return {
      status: "unknown",
      summary: "Privacy mode is not approved for this call.",
      findings,
      checkedAt,
    };
  }

  if (normalized.overlayVisible) {
    findings.push("CallPilot is visible locally. Test with an observer before sharing.");
  } else {
    findings.push("CallPilot window is hidden locally.");
  }

  if (normalized.contentProtectionEnabled) {
    findings.push("Best-effort capture protection is enabled.");
  } else {
    findings.push("Best-effort capture protection is disabled.");
  }

  if (normalized.mousePassthroughEnabled) {
    findings.push("Mouse passthrough is enabled.");
  }

  if (!normalized.overlayVisible && normalized.contentProtectionEnabled) {
    return {
      status: "safe",
      summary: "Local privacy posture is share-safe, pending platform observer check.",
      findings,
      checkedAt,
    };
  }

  return {
    status: "risk",
    summary: "Local privacy posture has visible or unprotected elements.",
    findings,
    checkedAt,
  };
};

export const reduceStealthState = (
  state: StealthState = defaultStealthState,
  action: StealthAction,
): StealthState => {
  switch (action.type) {
    case "set_call_privacy_allowed":
      return normalizeStealthState({ ...state, callPrivacyAllowed: Boolean(action.allowed) });
    case "set_overlay_visible":
      return normalizeStealthState({ ...state, overlayVisible: Boolean(action.visible) });
    case "set_content_protection":
      return normalizeStealthState({ ...state, contentProtectionEnabled: Boolean(action.enabled) });
    case "set_mouse_passthrough":
      return normalizeStealthState({
        ...state,
        mousePassthroughEnabled: Boolean(action.enabled),
        focusMode: action.enabled ? "passthrough" : "interactive",
      });
    case "set_focus_mode":
      return normalizeStealthState({ ...state, focusMode: action.focusMode });
    case "set_shortcut_layer":
      return normalizeStealthState({ ...state, shortcutLayerActive: Boolean(action.enabled) });
    case "apply_share_safe":
      return applyShareSafeState(state);
    case "reset_privacy":
      return resetPrivacyState();
    case "reset":
      return resetStealthState();
  }
};
