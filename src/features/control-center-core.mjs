const RUNNING_STATUSES = new Set(["queued", "sending", "streaming"]);
const DEPLETED_TEXT = /用尽|耗尽|DEPLETED|剩余\s*0(?:\D|$)/i;

function sameAccountKey(left, right) {
  return Boolean(left && right &&
    left.providerId === right.providerId &&
    left.uuid === right.uuid);
}

function isDepleted(value) {
  return typeof value === "string" && DEPLETED_TEXT.test(value);
}

function hasDepletedQuota(account) {
  const detail = account.quotaDetail;
  if (!detail) return false;

  const hasExtra = Boolean(
    detail.extraLabel || detail.extraValue ||
    detail.extraUsedPercent !== null && detail.extraUsedPercent !== undefined
  );
  const planDepleted =
    (typeof detail.planUsedPercent === "number" && detail.planUsedPercent >= 100) ||
    isDepleted(detail.planValue || "");
  const extraDepleted = hasExtra && (
    (typeof detail.extraUsedPercent === "number" && detail.extraUsedPercent >= 100) ||
    isDepleted(detail.extraValue || "")
  );
  const extraIsMonthlyCap = /月|monthly/i.test(detail.extraLabel || "");

  if (extraIsMonthlyCap) return planDepleted || extraDepleted;
  if (planDepleted) return !hasExtra || extraDepleted;
  return false;
}

/**
 * Read-only assessment for the Smart Router screen.
 * Final routing remains owned by SessionManager's existing routing pipeline.
 */
export function assessAccount(snapshot, account, now = Date.now()) {
  const reasons = [];
  const provider = (snapshot.providers || []).find((item) => item.id === account.providerId);
  const pageError = (snapshot.accountErrors || []).find((item) =>
    item.providerId === account.providerId && item.uuid === account.uuid
  );
  const hasActiveTurn = (snapshot.groupChats || []).some((group) =>
    (group.messages || []).some((message) =>
      sameAccountKey(message.sender, account) && RUNNING_STATUSES.has(message.status)
    )
  );

  if ((snapshot.conflicts || []).length > 0) {
    reasons.push("Selesaikan konflik UUID terlebih dahulu; routing grup sedang diblokir");
  }
  if (!provider || !provider.enabled) {
    reasons.push("Provider belum aktif");
  }
  if (account.authState !== "authenticated") {
    reasons.push(account.authState === "logged_out" ? "Sesi perlu login ulang" : "Status autentikasi belum terverifikasi");
  }
  if (typeof account.cookieExpiresAtMs === "number" && account.cookieExpiresAtMs <= now) {
    reasons.push("Cookie telah melewati waktu kedaluwarsa");
  }
  if (pageError && pageError.message) {
    reasons.push("WebView bermasalah: " + pageError.message);
  }
  if (hasDepletedQuota(account)) {
    reasons.push("Kuota terdeteksi habis");
  }
  if (hasActiveTurn) {
    reasons.push("Sedang menjalankan giliran pada Group Chat");
  }

  let status = "ready";
  if ((snapshot.conflicts || []).length > 0 || !provider || !provider.enabled || hasDepletedQuota(account)) {
    status = "blocked";
  } else if (account.authState !== "authenticated" ||
      (typeof account.cookieExpiresAtMs === "number" && account.cookieExpiresAtMs <= now)) {
    status = "needs-auth";
  } else if (pageError && pageError.message) {
    status = "attention";
  } else if (hasActiveTurn) {
    status = "busy";
  }

  return {
    status,
    eligible: status === "ready",
    busy: status === "busy",
    reasons,
    reasonText: reasons.length ? reasons.join(" · ") : "Tidak ada penghalang yang terlihat pada snapshot akun"
  };
}

export function summarizeRouter(assessments) {
  const summary = { total: assessments.length, ready: 0, busy: 0, blocked: 0, needsAuth: 0, attention: 0 };
  for (const item of assessments) {
    const status = item.status;
    if (status === "ready") summary.ready += 1;
    else if (status === "busy") summary.busy += 1;
    else if (status === "needs-auth") summary.needsAuth += 1;
    else if (status === "attention") summary.attention += 1;
    else summary.blocked += 1;
  }
  return summary;
}

export function summarizeAgentCenter(snapshot) {
  const groups = snapshot.groupChats || [];
  const messages = groups.flatMap((group) => group.messages || []);
  return {
    externalAgents: (snapshot.externalAgents || []).length,
    webAccounts: (snapshot.accounts || []).length,
    workspaces: groups.length,
    runningTurns: messages.filter((message) => RUNNING_STATUSES.has(message.status)).length,
    completedTurns: messages.filter((message) => message.role === "assistant" && message.status === "done").length,
    failedTurns: messages.filter((message) => message.status === "error" || message.status === "needs_auth").length
  };
}
