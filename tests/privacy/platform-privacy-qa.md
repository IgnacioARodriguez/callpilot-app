# Platform Privacy QA

This checklist verifies consent-based privacy behavior in ordinary video calls. It is not an anti-detection or proctoring bypass test.

## Preconditions

- Everyone in the call knows CallPilot is being tested.
- Use a second participant, second device, or recording reviewed by an authorized observer.
- Test both full-screen sharing and single-window sharing when the platform supports both.
- Keep a visible marker in CallPilot, such as `CALLPILOT PRIVACY TEST`, so the observer can clearly report whether app content appears.

## Platforms

- Google Meet
- Zoom
- Microsoft Teams

## Test Cases

### 1. Not Approved

1. Launch CallPilot.
2. Confirm the top bar says `Not approved`.
3. Try to activate `Hidden`, `Protected`, and `Passthrough`.
4. Start screen sharing.

Expected result: privacy controls remain unavailable, CallPilot stays visible locally, and no hidden/protected behavior is claimed.

### 2. Approved + Visible + Protected

1. Click `Not approved` so it becomes `Approved`.
2. Leave CallPilot visible.
3. Enable `Protected`.
4. Start screen sharing.
5. Ask the observer whether the `CALLPILOT PRIVACY TEST` marker is readable.

Pass: observer cannot read CallPilot content.

Fail: observer can read CallPilot content. Treat this platform/share-target combination as unsupported.

### 3. Approved + Hidden

1. Keep the call marked `Approved`.
2. Enable `Protected`.
3. Enable `Passthrough` if needed.
4. Click `Visible` so it becomes `Hidden`.
5. Start or continue screen sharing.
6. Ask the observer whether the CallPilot window appears.

Pass: observer cannot see the CallPilot window.

Fail: observer can see the CallPilot window or any readable CallPilot content.

## Reporting Template

```text
Date:
OS:
CallPilot version:
Platform:
Platform app/browser version:
Share target: entire_screen | window
State: not_approved | approved_visible_protected | approved_hidden
Observer result: pass | fail
Notes:
```

## Out Of Scope

- LeetCode or similar anti-cheat/proctoring detection checks.
- Bypassing browser, operating system, or platform integrity controls.
- Claims of universal invisibility across third-party platforms.
