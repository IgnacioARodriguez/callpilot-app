import React from "react";

const starterCode = `def solution(nums, target):
    seen = {}
    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen:
            return [seen[complement], index]
        seen[value] = index
    return []`;

export default function CodingOverlayApp() {
  return (
    <div className="cp-coding">
      <div className="cp-coding__bar">
        <div>
          <strong>Live Coding</strong>
          <span>Solution workspace</span>
        </div>
        <button type="button" onClick={() => window.callpilotDesktop?.endSession?.()}>End</button>
      </div>
      <div className="cp-coding__body">
        <section className="cp-code-panel">
          <div className="cp-panel-title">
            <strong>Solution</strong>
            <span>Python</span>
          </div>
          <pre><code>{starterCode}</code></pre>
        </section>
        <section className="cp-reasoning-panel">
          <div className="cp-panel-title">
            <strong>Reasoning</strong>
            <span>Explain while coding</span>
          </div>
          <div className="cp-mini-chat">
            <div>
              <strong>Approach</strong>
              <p>Use a hash map to trade O(n) memory for a single pass lookup.</p>
            </div>
            <div>
              <strong>Complexity</strong>
              <p>O(n) time and O(n) space. Each number is visited once.</p>
            </div>
            <div>
              <strong>What to say</strong>
              <p>I am storing previous values so every new value can check whether its complement already appeared.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
