import type { AccountRecord, ExternalAgentRecord, GroupChatMessage, GroupChatRecord, ManagerSnapshot } from "../types";
import { assessAccount, summarizeAgentCenter, summarizeRouter } from "./control-center-core.mjs";

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
    ready: "Siap dipertimbangkan",
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

function renderRouterRow(state: ManagerSnapshot, account: AccountRecord, now: number): string {
  const assessment = assessAccount(state, account, now);
  const provider = state.providers.find((item) => item.id === account.providerId);
  const expiry = typeof account.cookieExpiresAtMs === "number"
    ? formatDate(account.cookieExpiresAtMs)
    : account.cookieSessionOnly ? "Cookie sesi" : "Tidak tersedia";
  return [
    '<tr>',
    '<td><div class="cc-account-name">', escapeHtml(accountLabel(state, account)), '</div><div class="cc-subtle">',
    escapeHtml(provider?.shortName || account.providerId), ' · ', escapeHtml(account.uuid.slice(0, 8)), '</div></td>',
    '<td><span class="cc-status ', statusClass(assessment.status), '">', escapeHtml(statusLabel(assessment.status)), '</span></td>',
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
    ? '<div class="cc-table-wrap"><table class="cc-table"><thead><tr><th>Akun</th><th>Status</th><th>Indikator kuota</th><th>Cookie</th><th>Catatan eligibility</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<div class="cc-empty">Belum ada akun. Tambahkan akun melalui tab provider di sisi kiri.</div>';

  return [
    '<div class="cc-page">',
    '<header class="cc-page-header"><div><div class="cc-eyebrow">CONTROL CENTER / RESOURCE ROUTING</div><h1>Smart Router</h1><p>Monitoring kondisi akun berdasarkan snapshot Manager yang sudah digunakan aplikasi.</p></div>',
    '<button id="router-refresh-btn" class="btn primary" type="button">', '<span aria-hidden="true">↻</span> Sinkronkan kuota</button></header>',
    conflictNotice,
    '<section class="cc-stat-grid">',
    '<article class="cc-stat-card"><span>Total akun</span><strong>', String(summary.total), '</strong><small>Seluruh akun yang tersimpan</small></article>',
    '<article class="cc-stat-card"><span>Siap dipertimbangkan</span><strong class="cc-number-ready">', String(summary.ready), '</strong><small>Login valid, tidak sibuk, tanpa blocker terlihat</small></article>',
    '<article class="cc-stat-card"><span>Sedang digunakan</span><strong>', String(summary.busy), '</strong><small>Terlihat memiliki giliran aktif pada Group Chat</small></article>',
    '<article class="cc-stat-card"><span>Perlu perhatian</span><strong class="cc-number-alert">', String(summary.needsAuth + summary.attention + summary.blocked), '</strong><small>Autentikasi, konflik, kuota, atau error</small></article>',
    '</section>',
    '<section class="cc-panel"><div class="cc-panel-heading"><div><div class="cc-eyebrow">ROUTING ENGINE</div><h2>Strategi otomatis yang sedang digunakan</h2></div><span class="cc-pill cc-pill-live">Backend aktif</span></div>',
    '<div class="cc-router-flow">',
    '<div class="cc-flow-step"><span>01</span><strong>Eligibility</strong><small>Provider, login, cookie, error halaman, kuota</small></div>',
    '<div class="cc-flow-arrow">→</div>',
    '<div class="cc-flow-step"><span>02</span><strong>Availability</strong><small>Giliran aktif, cooldown, kapasitas worker</small></div>',
    '<div class="cc-flow-arrow">→</div>',
    '<div class="cc-flow-step"><span>03</span><strong>Selection</strong><small>Prioritas kuota, pemakaian terakhir, sticky route</small></div>',
    '</div>',
    '<p class="cc-note">Pemilihan final tetap dilakukan oleh SessionManager. Panel ini bersifat diagnostik dan tidak mengambil alih, mengunci, atau mengubah sesi akun. Cooldown serta lock internal tetap diputuskan backend saat dispatch.</p>',
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

function renderAgentCard(agent: ExternalAgentRecord): string {
  return [
    '<article class="cc-agent-card">',
    '<div class="cc-agent-mark ', agent.kind === "openai_api" ? "mark-api" : "mark-cli", '">', agent.kind === "openai_api" ? "API" : ">_", '</div>',
    '<div class="cc-agent-card-main"><strong>', escapeHtml(agent.name), '</strong><span>', escapeHtml(agentSecondary(agent)), '</span></div>',
    '<span class="cc-pill">', agentKindLabel(agent), '</span>',
    '<button class="cc-icon-action" data-open-ext-agent-id="', escapeHtml(agent.id), '" type="button" aria-label="Edit ', escapeHtml(agent.name), '">Edit</button>',
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

export function renderAgentCenter(state: ManagerSnapshot): string {
  const summary = summarizeAgentCenter(state);
  const externalAgents = state.externalAgents || [];
  const agentCards = externalAgents.length
    ? externalAgents.map(renderAgentCard).join("")
    : '<div class="cc-empty">Belum ada API / CLI agent. Tambahkan lewat pengelola agent yang sudah ada.</div>';
  const workspaces = state.groupChats.length
    ? state.groupChats.map(renderWorkspaceCard).join("")
    : '<div class="cc-empty">Belum ada workspace. Buat workspace untuk menggabungkan akun web, API, dan CLI.</div>';

  return [
    '<div class="cc-page">',
    '<header class="cc-page-header"><div><div class="cc-eyebrow">CONTROL CENTER / MULTI-AGENT OPERATIONS</div><h1>Agent Center</h1><p>Satu tempat untuk mengelola agent, tim kolaborasi, dan aktivitas eksekusi yang sudah tersedia.</p></div>',
    '<div class="cc-header-actions"><button id="agent-manage-btn" class="btn" type="button">Kelola agent</button><button id="agent-create-workspace-btn" class="btn primary" type="button">+ Workspace baru</button></div></header>',
    '<section class="cc-stat-grid cc-stat-grid-five">',
    '<article class="cc-stat-card"><span>Agent API / CLI</span><strong>', String(summary.externalAgents), '</strong><small>Profil eksternal terdaftar</small></article>',
    '<article class="cc-stat-card"><span>Akun web</span><strong>', String(summary.webAccounts), '</strong><small>Resource Muse / provider</small></article>',
    '<article class="cc-stat-card"><span>Workspace</span><strong>', String(summary.workspaces), '</strong><small>Group Chat yang dapat dipakai ulang</small></article>',
    '<article class="cc-stat-card"><span>Giliran aktif</span><strong>', String(summary.runningTurns), '</strong><small>Queued, sending, streaming</small></article>',
    '<article class="cc-stat-card"><span>Hasil / error</span><strong>', String(summary.completedTurns), '<small>', String(summary.failedTurns), ' perlu perhatian</small></strong><small>Riwayat dari pesan agent</small></article>',
    '</section>',
    '<section class="cc-panel"><div class="cc-panel-heading"><div><div class="cc-eyebrow">AGENT REGISTRY</div><h2>Agent yang sudah terdaftar</h2></div><button id="agent-manage-inline-btn" class="cc-text-action" type="button">Buka pengelola →</button></div>',
    '<div class="cc-agent-grid">', agentCards, '</div>',
    '<p class="cc-note">Profil API / CLI menggunakan registry dan penyimpanan yang sudah ada. Akun Muse / Hark tetap dikelola di tab provider; tidak ada kredensial yang disalin ke profil baru.</p>',
    '</section>',
    '<section class="cc-panel"><div class="cc-panel-heading"><div><div class="cc-eyebrow">TEAM WORKSPACES</div><h2>Ruang kolaborasi</h2></div><span class="cc-count">', String(summary.workspaces), ' workspace</span></div>',
    '<div class="cc-workspace-grid">', workspaces, '</div>',
    '</section>',
    '<section class="cc-panel"><div class="cc-panel-heading"><div><div class="cc-eyebrow">EXECUTION ACTIVITY</div><h2>Aktivitas terbaru</h2></div></div>',
    renderActivity(state),
    '</section>',
    '</div>'
  ].join("");
}
