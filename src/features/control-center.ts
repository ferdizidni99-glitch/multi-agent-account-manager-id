import type { AccountHealthResult, AccountRecord, AgentConnectionTestResult, ExternalAgentRecord, GroupChatMessage, GroupChatRecord, ManagerSnapshot } from "../types";
import { assessAccount, summarizeRouter } from "./control-center-core.mjs";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleString();
}

function accountLabel(state: ManagerSnapshot, account: AccountRecord): string {
  const provider = state.providers.find((item) => item.id === account.providerId);
  return account.alias || provider?.shortName || account.providerId;
}

function memberLabel(state: ManagerSnapshot, key: { providerId: string; uuid: string } | null): string {
  if (!key) return "System";
  if (key.providerId === "api" || key.providerId === "cli") {
    const ext = (state.externalAgents || []).find((item) => item.id === key.uuid);
    return ext?.name || (key.providerId === "api" ? "API Agent" : "CLI Agent");
  }
  const account = state.accounts.find((item) => item.providerId === key.providerId && item.uuid === key.uuid);
  return account ? accountLabel(state, account) : key.providerId;
}

function workflowLabel(group: GroupChatRecord): string {
  const mode = group.workflowMode || "parallel";
  if (mode === "review") return "Review Workflow";
  if (mode === "a2a_relay") return "A2A Relay";
  return "Parallel";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    ready: "Tidak ada blocker tercatat",
    busy: "Sedang digunakan",
    blocked: "Terblokir",
    "needs-auth": "Perlu autentikasi",
    attention: "Perlu pemeriksaan"
  };
  return labels[status] || status;
}

function statusClass(status: string): string {
  if (status === "ready") return "is-ready";
  if (status === "busy") return "is-busy";
  if (status === "needs-auth") return "is-auth";
  if (status === "attention") return "is-attention";
  return "is-blocked";
}

function quotaLabel(account: AccountRecord): string {
  if (account.quotaText) return account.quotaText;
  const detail = account.quotaDetail;
  if (detail && detail.planValue) return detail.planValue;
  return "Belum ada data kuota";
}

function liveHealthLabel(result: AccountHealthResult | undefined): string {
  if (!result || result.status === "not_checked") return "Belum diperiksa";
  if (result.status === "checking") return "Sedang diperiksa";
  if (result.status === "healthy") return result.quotaVerified ? "Token + kuota terverifikasi" : "Token terverifikasi";
  if (result.status === "needs_auth") return "Perlu login ulang";
  if (result.status === "attention") return "Ada kendala";
  return "Belum terverifikasi";
}

function liveHealthClass(result: AccountHealthResult | undefined): string {
  if (result?.status === "healthy") return "is-ready";
  if (result?.status === "needs_auth") return "is-auth";
  if (result?.status === "checking") return "is-busy";
  return "is-attention";
}

function renderRouterRow(state: ManagerSnapshot, account: AccountRecord, now: number): string {
  const assessment = assessAccount(state, account, now);
  const liveHealth = (state.accountHealth || []).find((item) =>
    item.providerId === account.providerId && item.uuid === account.uuid
  );
  const provider = state.providers.find((item) => item.id === account.providerId);
  const expiry = typeof account.cookieExpiresAtMs === "number"
    ? formatDate(account.cookieExpiresAtMs)
    : account.cookieSessionOnly ? "Cookie sesi" : "Tidak tersedia";
  return [
    '<tr>',
    '<td><div class="cc-account-name">', escapeHtml(accountLabel(state, account)), '</div><div class="cc-subtle">',
    escapeHtml(provider?.shortName || account.providerId), ' · ', escapeHtml(account.uuid.slice(0, 8)), '</div></td>',
    '<td><span class="cc-status ', statusClass(assessment.status), '">', escapeHtml(statusLabel(assessment.status)), '</span></td>',
    '<td><span class="cc-status ', liveHealthClass(liveHealth), '">', escapeHtml(liveHealthLabel(liveHealth)), '</span><div class="cc-subtle">',
    escapeHtml(liveHealth?.checkedAtMs ? formatDate(liveHealth.checkedAtMs) : "Belum ada waktu pemeriksaan"), '</div><div class="cc-subtle">',
    escapeHtml(liveHealth?.message || "Perlu WebView warm untuk pemeriksaan endpoint"), '</div></td>',
    '<td>', escapeHtml(quotaLabel(account)), '</td>',
    '<td>', escapeHtml(expiry), '</td>',
    '<td class="cc-reason">', escapeHtml(assessment.reasonText), '</td>',
    '</tr>'
  ].join("");
}

export function renderSmartRouter(state: ManagerSnapshot): string {
  const now = Date.now();
  const assessments = state.accounts.map((account) => assessAccount(state, account, now));
  const summary = summarizeRouter(assessments);
  const rows = state.accounts.map((account) => renderRouterRow(state, account, now)).join("");
  const conflictNotice = state.conflicts.length
    ? '<div class="cc-alert"><strong>Routing ditahan:</strong> selesaikan konflik UUID di daftar akun terlebih dahulu. Mekanisme Group Chat yang lama memang menolak dispatch selama konflik masih ada.</div>'
    : "";
  const accountTable = state.accounts.length
    ? '<div class="cc-table-wrap"><table class="cc-table"><thead><tr><th>Akun</th><th>Eligibility snapshot</th><th>Pemeriksaan live</th><th>Indikator kuota</th><th>Cookie</th><th>Catatan eligibility</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<div class="cc-empty">Belum ada akun. Tambahkan akun melalui tab provider di sisi kiri.</div>';

  return [
    '<div class="cc-page">',
    '<header class="cc-page-header"><div><div class="cc-eyebrow">CONTROL CENTER / RESOURCE ROUTING</div><h1>Smart Router</h1><p>Diagnostik read-only berdasarkan snapshot SessionManager. Ini bukan pemeriksaan live untuk semua akun.</p></div>',
    '<button id="router-refresh-btn" class="btn primary" type="button">', '<span aria-hidden="true">↻</span> Refresh akun WebView warm</button></header>',
    conflictNotice,
    '<section class="cc-stat-grid">',
    '<article class="cc-stat-card"><span>Total akun</span><strong>', String(summary.total), '</strong><small>Seluruh akun yang tersimpan</small></article>',
    '<article class="cc-stat-card"><span>Tidak ada blocker tercatat</span><strong class="cc-number-ready">', String(summary.ready), '</strong><small>Tidak ada blocker pada data yang tersedia</small></article>',
    '<article class="cc-stat-card"><span>Sedang digunakan</span><strong>', String(summary.busy), '</strong><small>Terlihat memiliki giliran aktif pada Group Chat</small></article>',
    '<article class="cc-stat-card"><span>Perlu perhatian</span><strong class="cc-number-alert">', String(summary.needsAuth + summary.attention + summary.blocked), '</strong><small>Autentikasi, konflik, kuota, atau error</small></article>',
    '</section>',
    '<section class="cc-panel"><div class="cc-panel-heading"><div><div class="cc-eyebrow">ROUTING ENGINE</div><h2>Alur routing backend yang sudah ada</h2></div><span class="cc-pill">Diputuskan SessionManager</span></div>',
    '<div class="cc-router-flow">',
    '<div class="cc-flow-step"><span>01</span><strong>Eligibility</strong><small>Provider, login, cookie, error halaman, kuota</small></div>',
    '<div class="cc-flow-arrow">→</div>',
    '<div class="cc-flow-step"><span>02</span><strong>Availability</strong><small>Giliran aktif, cooldown, kapasitas worker</small></div>',
    '<div class="cc-flow-arrow">→</div>',
    '<div class="cc-flow-step"><span>03</span><strong>Selection</strong><small>Prioritas kuota, pemakaian terakhir, sticky route</small></div>',
    '</div>',
    '<p class="cc-note">Pemeriksaan live memakai endpoint autentikasi provider dari WebView yang sedang warm. Akun yang tidak warm tetap berstatus “Belum diperiksa” dan tidak dianggap sehat. Token dan kuota dilaporkan terpisah: token dapat terverifikasi meski refresh kuota belum berhasil. Hasil diperbarui asynchronous dari SessionManager. Eligibility snapshot tetap diagnostik; cooldown, lock, failover, serta pemilihan final tetap diputuskan backend.</p>',
    '</section>',
    '<section class="cc-panel"><div class="cc-panel-heading"><div><div class="cc-eyebrow">ACCOUNT RESOURCE POOL</div><h2>Kondisi akun</h2></div><span class="cc-count">', String(summary.total), ' akun</span></div>',
    accountTable,
    '</section>',
    '</div>'
  ].join("");
}

function agentKindLabel(agent: ExternalAgentRecord): string {
  return agent.kind === "openai_api" ? "API" : "CLI";
}

function agentSecondary(agent: ExternalAgentRecord): string {
  if (agent.kind === "openai_api") return agent.model || "Model belum diisi";
  return agent.command || "Command belum diisi";
}

function agentTestLabel(result: AgentConnectionTestResult | undefined): string {
  if (!result) return "Belum dites";
  const labels: Record<string, string> = {
    healthy: "Terhubung", auth_error: "API key ditolak", rate_limited: "Rate limit",
    server_error: "Server error", http_error: "HTTP error", unreachable: "Tidak terjangkau",
    timeout: "Timeout", not_found: "CLI tidak ditemukan", command_error: "CLI gagal",
    configuration_error: "Konfigurasi belum lengkap", error: "Gagal dites"
  };
  return labels[result.status] || result.status;
}

function agentTestClass(result: AgentConnectionTestResult | undefined): string {
  if (result?.status === "healthy") return "is-ready";
  if (result?.status === "auth_error" || result?.status === "configuration_error" || result?.status === "not_found" || result?.status === "command_error") return "is-auth";
  if (result) return "is-attention";
  return "is-busy";
}

function renderAgentCard(agent: ExternalAgentRecord, result?: AgentConnectionTestResult): string {
  return [
    '<article class="cc-agent-card">',
    '<div class="cc-agent-mark ', agent.kind === "openai_api" ? "mark-api" : "mark-cli", '">', agent.kind === "openai_api" ? "API" : ">_", '</div>',
    '<div class="cc-agent-card-main"><strong>', escapeHtml(agent.name), '</strong><span>', escapeHtml(agentSecondary(agent)), '</span>',
    '<span class="cc-status ', agentTestClass(result), '">', escapeHtml(agentTestLabel(result)), '</span>',
    result ? '<small class="cc-subtle">' + escapeHtml(result.message) + ' · ' + escapeHtml(formatDate(result.checkedAtMs)) + ' · ' + String(result.latencyMs) + ' ms</small>' : '',
    '</div>',
    '<span class="cc-pill">', agentKindLabel(agent), '</span>',
    '<div class="cc-agent-card-actions"><button class="btn small" data-test-ext-agent-id="', escapeHtml(agent.id), '" type="button">Tes koneksi</button>',
    '<button class="cc-icon-action" data-open-ext-agent-id="', escapeHtml(agent.id), '" type="button" aria-label="Edit ', escapeHtml(agent.name), '">Edit</button></div>',
    '</article>'
  ].join("");
}

function renderWorkspaceCard(group: GroupChatRecord): string {
  const active = group.messages.filter((message) => message.status === "queued" || message.status === "sending" || message.status === "streaming").length;
  const members = group.members.length;
  return [
    '<article class="cc-workspace-card">',
    '<div class="cc-workspace-top"><div class="cc-workspace-icon">✳</div><span class="cc-pill">', escapeHtml(workflowLabel(group)), '</span></div>',
    '<h3>', escapeHtml(group.name), '</h3>',
    '<p>', String(members), ' anggota · ', String(group.messages.length), ' pesan</p>',
    '<div class="cc-workspace-bottom"><span class="cc-subtle">', active ? String(active) + ' giliran aktif' : "Tidak ada giliran aktif", '</span>',
    '<button class="btn small" data-open-agent-workspace="', escapeHtml(group.id), '" type="button">Buka workspace</button></div>',
    '</article>'
  ].join("");
}

function renderActivity(state: ManagerSnapshot): string {
  const activity: Array<{ group: GroupChatRecord; message: GroupChatMessage }> = [];
  for (const group of state.groupChats) {
    for (const message of group.messages) {
      if (message.role === "assistant" || message.status === "queued" || message.status === "sending" || message.status === "streaming") {
        activity.push({ group, message });
      }
    }
  }
  activity.sort((a, b) => b.message.createdAtMs - a.message.createdAtMs);
  const items = activity.slice(0, 6);
  if (!items.length) return '<div class="cc-empty">Aktivitas agent akan muncul setelah workspace menjalankan percakapan.</div>';
  return '<div class="cc-activity-list">' + items.map(({ group, message }) => {
    const label = message.status === "done" ? "Selesai"
      : message.status === "error" ? "Gagal"
      : message.status === "needs_auth" ? "Perlu login"
      : message.status === "streaming" ? "Streaming"
      : message.status === "sending" ? "Mengirim" : "Dalam antrean";
    return [
      '<div class="cc-activity-row"><span class="cc-activity-dot ', statusClass(message.status === "done" ? "ready" : message.status === "error" || message.status === "needs_auth" ? "blocked" : "busy"), '"></span>',
      '<div class="cc-activity-main"><strong>', escapeHtml(memberLabel(state, message.sender)), '</strong><span>', escapeHtml(group.name), message.stageLabel ? ' · ' + escapeHtml(message.stageLabel) : '', '</span></div>',
      '<span class="cc-activity-status">', label, '</span></div>'
    ].join("");
  }).join("") + '</div>';
}

export interface AgentOfficeInput {
  id: string;
  name: string;
  state: "running" | "attention" | "idle";
  detail: string;
}

export function buildAgentOfficeRoster(state: ManagerSnapshot): AgentOfficeInput[] {
  const activity = new Map<string, { state: AgentOfficeInput["state"]; detail: string; at: number }>();
  for (const group of state.groupChats) {
    for (const message of group.messages) {
      if (!message.sender) continue;
      const key = message.sender.providerId + ":" + message.sender.uuid;
      const at = message.createdAtMs || 0;
      const running = message.status === "queued" || message.status === "sending" || message.status === "streaming";
      const attention = message.status === "error" || message.status === "needs_auth";
      const previous = activity.get(key);
      if (previous && previous.at > at) continue;
      activity.set(key, {
        state: running ? "running" : attention ? "attention" : "idle",
        detail: message.stageLabel || (message.error ? message.error.slice(0, 100) : group.name),
        at
      });
    }
  }
  const accounts = state.accounts.map((account): AgentOfficeInput => {
    const key = account.providerId + ":" + account.uuid;
    const latest = activity.get(key);
    const provider = state.providers.find((item) => item.id === account.providerId);
    const loggedOut = account.authState === "logged_out";
    const authUnknown = account.authState === "unknown";
    return {
      id: "account:" + key,
      name: account.alias || provider?.shortName || account.providerId,
      state: latest?.state === "running" ? "running" : loggedOut || latest?.state === "attention" ? "attention" : "idle",
      detail: latest?.detail || (loggedOut ? "Perlu login ulang" : authUnknown ? "Status login belum diverifikasi" : provider?.shortName || "Akun siap digunakan")
    };
  });
  const external = (state.externalAgents || []).map((agent): AgentOfficeInput => {
    const providerId = agent.kind === "openai_api" ? "api" : "cli";
    const key = providerId + ":" + agent.id;
    const latest = activity.get(key);
    return {
      id: "external:" + key,
      name: agent.name,
      state: latest?.state || "idle",
      detail: latest?.detail || (agent.kind === "openai_api" ? agent.model || "API agent" : agent.command || "CLI agent")
    };
  });
  return [...accounts, ...external];
}

export function renderAgentCenter(
  state: ManagerSnapshot,
  connectionResults: Record<string, AgentConnectionTestResult> = {}
): string {
  const agents = buildAgentOfficeRoster(state);
  const running = agents.filter((agent) => agent.state === "running").length;
  const attention = agents.filter((agent) => agent.state === "attention").length;
  const externalAgents = state.externalAgents || [];
  const agentCards = externalAgents.length
    ? externalAgents.map((agent) => renderAgentCard(agent, connectionResults[agent.id])).join("")
    : '<div class="cc-empty">Belum ada koneksi eksternal. Akun Muse dan provider web tetap tampil sebagai agent.</div>';
  const workspaces = state.groupChats.length
    ? state.groupChats.map(renderWorkspaceCard).join("")
    : '<div class="cc-empty">Belum ada workspace. Buat workspace untuk menggabungkan akun yang tersedia.</div>';
  const rosterHtml = agents.length
    ? agents.map((agent) => [
        '<div class="agent-office-roster-row">',
        '<span class="agent-office-presence ', agent.state, '"></span>',
        '<div class="agent-office-roster-meta"><strong>', escapeHtml(agent.name), '</strong>',
        '<span>', escapeHtml(agent.detail), '</span></div>',
        '<span class="agent-office-roster-state ', agent.state, '">', agent.state === "running" ? "Bekerja" : agent.state === "attention" ? "Perhatian" : "Siaga", '</span>',
        '</div>'
      ].join("")).join("")
    : '<div class="cc-empty">Tambahkan akun provider untuk mengisi kantor agent.</div>';

  return [
    '<div class="agent-office-page">',
    '<header class="agent-office-header"><div><div class="cc-eyebrow">叠号 / MULTI-AGENT WORKSPACE</div><h1>Agent Office</h1><p>Pantau agent dari akun yang tersimpan dan aktivitas kerja di workspace MAAM.</p></div>',
    '<div class="cc-header-actions"><button id="agent-manage-btn" class="btn" type="button">Kelola koneksi</button><button id="agent-create-workspace-btn" class="btn primary" type="button">+ Workspace</button></div></header>',
    '<section class="agent-office-stats">',
    '<article><span>Total agent</span><strong>', String(agents.length), '</strong><small>Akun web + koneksi eksternal</small></article>',
    '<article><span>Sedang bekerja</span><strong class="is-running">', String(running), '</strong><small>Aktivitas aktif di Group Chat</small></article>',
    '<article><span>Perlu perhatian</span><strong class="is-attention">', String(attention), '</strong><small>Login atau pesan bermasalah</small></article>',
    '<article><span>Workspace</span><strong>', String(state.groupChats.length), '</strong><small>Ruang kolaborasi tersimpan</small></article>',
    '</section>',
    '<div class="agent-office-layout">',
    '<section class="agent-office-scene-panel">',
    '<div class="agent-office-scene-heading"><div><span class="cc-eyebrow">LIVE SIMULATION</span><h2>MAAM virtual office</h2></div><span class="agent-office-live-indicator"><i></i> LIVE</span></div>',
    '<div class="agent-office-canvas-wrap"><canvas id="agent-office-canvas" aria-label="Animasi kantor virtual agent"></canvas><div class="agent-office-canvas-shade"></div></div>',
    '<div class="agent-office-scene-footer"><span id="agent-office-render-status">Menginisialisasi mesin visual Pixtuoid…</span><span>Pixtuoid scene engine</span></div>',
    '</section>',
    '<aside class="agent-office-side-panel">',
    '<div class="agent-office-side-heading"><div><span class="cc-eyebrow">AGENT ROSTER</span><h2>Rekan kerja</h2></div><span class="cc-count">', String(agents.length), '</span></div>',
    '<div class="agent-office-roster">', rosterHtml, '</div>',
    '<div class="agent-office-side-heading agent-office-activity-heading"><div><span class="cc-eyebrow">LATEST SIGNALS</span><h2>Aktivitas terbaru</h2></div></div>',
    '<div class="agent-office-activity">', renderActivity(state), '</div>',
    '</aside>',
    '</div>',
    '<section class="agent-office-bottom-panel"><div class="agent-office-bottom-heading"><div><span class="cc-eyebrow">TEAM SPACES</span><h2>Workspace</h2></div><span class="cc-count">', String(state.groupChats.length), ' ruang</span></div>',
    '<div class="cc-workspace-grid">', workspaces, '</div></section>',
    '<section class="agent-office-bottom-panel"><div class="agent-office-bottom-heading"><div><span class="cc-eyebrow">CONNECTED RUNTIMES</span><h2>Koneksi API / CLI</h2></div><button id="agent-manage-inline-btn" class="cc-text-action" type="button">Kelola →</button></div>',
    '<div class="cc-agent-grid">', agentCards, '</div>',
    '<p class="cc-note">Status sprite mengikuti aktivitas Group Chat yang tercatat di MAAM. Simulasi kantor hanya memvisualisasikan event yang dikirim aplikasi; tidak mengubah sesi, cookie, atau keputusan routing akun.</p>',
    '</section>',
    '</div>'
  ].join("");
}
