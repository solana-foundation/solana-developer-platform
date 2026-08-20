---
name: sdp-bug-report
description: File an SDP bug to Linear as a sub-issue of the ongoing bug-bash epic PRO-1482, with concise numbered repro steps and a browser screenshot attached. Use only when explicitly invoked for an SDP dashboard or API bug. Not for feature requests or planning tickets.
disable-model-invocation: true
---

# sdp-bug-report

File one bug to Linear under the bug-bash epic, with a screenshot proving it. This is the one sanctioned exception to "skills file to GitHub Issues" — bug-bash bugs go to Linear because the epic lives there.

Fixed coordinates:
- Team: **Product Engineering** (id `8b2a5825-10f9-469c-b547-a1d57629b16c`)
- Parent: **PRO-1482** (Epic: SDP Ongoing Bug Bash)

## Required capabilities

Resolve tools by capability rather than by agent-specific names:

- Linear issue creation and issue-description updates.
- Linear inline-asset upload preparation.
- Browser tab inspection, navigation, interaction, JavaScript execution, and screenshots saved to disk.

Claude Code may expose these through Linear MCP and browser-extension tools; Codex may expose them through apps, MCP connectors, or browser/computer tools. If the required Linear capability is unavailable, stop before filing and state which connector is missing. Do not file the bug in another tracker.

## Workflow

### 1. Extract the bug from the conversation

Pull from what the reporter already said: what they did, what they expected, what actually happened, and where (URL/page, local vs deployed). Ask ONE batched question only for genuinely missing essentials — never a multi-turn interview. If they pasted an error or described steps, that's enough; don't re-ask what's already in the conversation.

### 2. Reproduce in the browser, highlight, screenshot

Inspect the current browser tabs first, then create a new tab so the reporter's existing tabs are not hijacked. Chromium-compatible browser tools are sufficient; do not assume the browser product from the tool name.

1. Navigate to the affected page (local dev at `http://localhost:3000` unless he says deployed).
2. Perform the repro steps until the bug is visible on screen.
3. Highlight the buggy element with a red box through the browser's JavaScript capability — the lightest possible path, no image-editing tools needed:
   ```js
   const el = document.querySelector('<selector for the buggy element>');
   el.style.outline = '3px solid #ef4444'; el.style.outlineOffset = '2px';
   ```
4. Save a browser screenshot to disk and retain the returned file path. Do NOT use `screencapture`/`osascript` (they can target the wrong browser and require terminal Screen Recording permission).
5. Remove the outline afterwards (set `el.style.outline = ''`) so the page is clean if the reporter keeps the tab.

If reproduction fails after 2–3 honest attempts, stop trying: file the bug anyway, say "could not reproduce via browser automation" in the body, and skip the screenshot. Never fake or stage a screenshot of a bug you didn't actually see.

### 3. File the issue

Use the available Linear issue-creation capability: team `Product Engineering`, parent `PRO-1482`, title `Bug: <symptom in ≤8 words>`. Leave priority/assignee/labels unset unless the reporter specified them.

Body is Repro + Expected ONLY — the title carries the symptom, the screenshot carries the actual. No summary sentence, no Env, no Notes:

```markdown
**Repro**

1. <step>
2. <step>
3. <step — each step one action, exact clicks/values/URLs>

**Expected:** <one line>
```

### 4. Embed the screenshot as inline media

1. Use the Linear inline-asset upload preparation capability for the image (correct filename, correct MIME type, byte size from `stat -f%z`).
2. Immediately `curl -X PUT --data-binary @file` to the returned URL with the returned headers verbatim (signed URL dies in 60s — never batch other work between prepare and PUT).
3. Do not create a separate attachment resource. Instead update the issue description, appending `![<short alt>](<assetUrl>)` (the bare asset URL from preparation, without signature parameters — Linear signs it on save).

If any upload step fails, still deliver the issue URL and tell Zach the screenshot didn't embed — a filed bug without a picture beats no bug.

### 5. Report back

One line: the issue identifier + URL, plus the screenshot status. Done. No recap of the bug body.
