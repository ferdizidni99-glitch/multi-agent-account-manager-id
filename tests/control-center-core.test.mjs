import test from "node:test";
import assert from "node:assert/strict";
import { assessAccount, summarizeRouter, summarizeAgentCenter } from "../src/features/control-center-core.mjs";

const now = 1_800_000_000_000;
function account(overrides = {}) {
  return {
    providerId: "muse",
    uuid: "account-1",
    alias: "Muse One",
    authState: "authenticated",
    cookieExpiresAtMs: null,
    cookieSessionOnly: true,
    quotaDetail: null,
    ...overrides
  };
}
function snapshot(overrides = {}) {
  return {
    providers: [{ id: "muse", enabled: true, shortName: "Muse" }],
    accounts: [],
    conflicts: [],
    accountErrors: [],
    groupChats: [],
    externalAgents: [],
    ...overrides
  };
}

test("unknown quota is visible as unverified rather than ready", () => {
  const result = assessAccount(snapshot(), account(), now);
  assert.equal(result.status, "attention");
  assert.equal(result.eligible, false);
  assert.match(result.reasonText, /kuota belum terverifikasi/);
});

test("a known non-depleted quota can be diagnostically ready", () => {
  const result = assessAccount(snapshot(), account({
    quotaText: "Sisa kuota 80%",
    quotaPercent: 80
  }), now);
  assert.equal(result.status, "ready");
  assert.equal(result.eligible, true);
});

test("logged out accounts need authentication", () => {
  const result = assessAccount(snapshot(), account({ authState: "logged_out" }), now);
  assert.equal(result.status, "needs-auth");
  assert.equal(result.eligible, false);
});

test("expired cookies are not marked ready", () => {
  const result = assessAccount(snapshot(), account({ cookieExpiresAtMs: now - 1 }), now);
  assert.equal(result.status, "needs-auth");
  assert.match(result.reasonText, /kedaluwarsa/);
});

test("disabled providers are blocked", () => {
  const result = assessAccount(snapshot({ providers: [{ id: "muse", enabled: false }] }), account(), now);
  assert.equal(result.status, "blocked");
});

test("UUID conflicts pause routing for every group account", () => {
  const result = assessAccount(snapshot({ conflicts: [{ uuid: "duplicate", providers: ["muse"] }] }), account(), now);
  assert.equal(result.status, "blocked");
  assert.match(result.reasonText, /konflik UUID/);
});

test("active group turns are displayed as busy", () => {
  const state = snapshot({
    groupChats: [{
      messages: [{
        sender: { providerId: "muse", uuid: "account-1" },
        status: "streaming"
      }]
    }]
  });
  const result = assessAccount(state, account(), now);
  assert.equal(result.status, "busy");
  assert.equal(result.busy, true);
});

test("a quota is considered depleted only when quota detail explicitly confirms it", () => {
  const result = assessAccount(snapshot(), account({
    quotaDetail: {
      planValue: "剩余 0",
      planUsedPercent: 100,
      extraLabel: null,
      extraValue: null,
      extraUsedPercent: null
    }
  }), now);
  assert.equal(result.status, "blocked");
  assert.match(result.reasonText, /kuota/i);
});

test("quota summary tallies each account status once", () => {
  const summary = summarizeRouter([
    { status: "ready" }, { status: "busy" }, { status: "blocked" },
    { status: "needs-auth" }, { status: "attention" }
  ]);
  assert.deepEqual(summary, {
    total: 5, ready: 1, busy: 1, blocked: 1, needsAuth: 1, attention: 1
  });
});

test("agent center totals existing workspace activity without inventing tasks", () => {
  const summary = summarizeAgentCenter(snapshot({
    accounts: [{ uuid: "a" }, { uuid: "b" }],
    externalAgents: [{ id: "api" }],
    groupChats: [{
      messages: [
        { status: "streaming", role: "assistant" },
        { status: "done", role: "assistant" },
        { status: "error", role: "assistant" },
        { status: "needs_auth", role: "assistant" }
      ]
    }]
  }));
  assert.deepEqual(summary, {
    externalAgents: 1, webAccounts: 2, workspaces: 1,
    runningTurns: 1, completedTurns: 1, failedTurns: 2
  });
});
