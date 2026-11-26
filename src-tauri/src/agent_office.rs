use base64::Engine as _;
use pixtuoid_web::Office;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{State, Webview};

const MAX_OFFICE_AGENTS: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOfficeInput { id: String, name: String, state: String, detail: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOfficeFrame { data_url: String, width: u32, height: u32, agent_count: usize }

#[derive(Debug)]
struct TrackedAgent {
    session_id: String,
    cwd: String,
    task: Option<(String, String)>,
    task_sequence: u64,
}

#[derive(Debug)]
struct AgentOfficeRuntime { office: Office, agents: HashMap<String, TrackedAgent> }

#[derive(Default)]
pub struct AgentOfficeState { runtime: Mutex<Option<AgentOfficeRuntime>> }

#[tauri::command]
pub fn render_agent_office_frame(
    state: State<'_, AgentOfficeState>,
    webview: Webview,
    agents: Vec<AgentOfficeInput>,
    width: u32,
    height: u32,
) -> Result<AgentOfficeFrame, String> {
    if webview.label() != "manager" {
        return Err("Agent Office hanya dapat dirender dari jendela utama".to_string());
    }
    let width = width.clamp(480, 1280);
    let height = height.clamp(280, 760);
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1_000.0;
    let mut guard = state.runtime.lock().map_err(|_| "Agent Office renderer sedang tidak tersedia".to_string())?;
    if guard.is_none() {
        let mut office = Office::journey(0x4D41_414D).map_err(|error| format!("Gagal menginisialisasi Pixtuoid: {error:?}"))?;
        office.set_weather(None);
        *guard = Some(AgentOfficeRuntime { office, agents: HashMap::new() });
    }
    let runtime = guard.as_mut().ok_or_else(|| "Agent Office belum siap".to_string())?;
    sync_agents(runtime, agents, now_ms)?;

    let fit = runtime.office.fit(width, height);
    if fit.len() != 4 { return Err("Pixtuoid mengembalikan ukuran frame yang tidak valid".to_string()); }
    let _written = runtime.office.step(now_ms, width, height);
    let scale = runtime.office.scale();
    let frame_width = fit[0].saturating_mul(scale);
    let frame_height = fit[1].saturating_mul(scale);
    let frame_len = runtime.office.frame_len();
    let expected_len = (frame_width as usize).checked_mul(frame_height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Ukuran frame Pixtuoid terlalu besar".to_string())?;
    if frame_len != expected_len || frame_len == 0 {
        return Err(format!("Ukuran buffer Pixtuoid tidak cocok ({} bytes, expected {})", frame_len, expected_len));
    }
    let rgba = unsafe {
        // SAFETY: Office owns this allocation; the pointer and length are read
        // immediately after step, and the mutex prevents reallocation until
        // the PNG encoder has consumed the borrowed slice.
        std::slice::from_raw_parts(runtime.office.frame_ptr(), frame_len)
    };
    let png_bytes = encode_png(rgba, frame_width, frame_height)?;
    let data_url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png_bytes));
    Ok(AgentOfficeFrame { data_url, width: frame_width, height: frame_height, agent_count: runtime.agents.len() })
}

fn sync_agents(runtime: &mut AgentOfficeRuntime, agents: Vec<AgentOfficeInput>, now_ms: f64) -> Result<(), String> {
    let mut seen = HashSet::new();
    let office = &mut runtime.office;
    for agent in agents.into_iter().take(MAX_OFFICE_AGENTS) {
        let id = agent.id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) { continue; }
        let agent_id = id.to_string();
        let is_new = !runtime.agents.contains_key(&agent_id);
        if is_new {
            runtime.agents.insert(agent_id.clone(), TrackedAgent {
                session_id: stable_session_id(id),
                cwd: format!("C:/MAAM/Agents/{}", safe_slug(&agent.name)),
                task: None,
                task_sequence: 0,
            });
        }
        let tracked = runtime.agents.get_mut(&agent_id).ok_or_else(|| "Agent Office kehilangan sesi".to_string())?;
        if is_new {
            send_hook(office, json!({
                "session_id": tracked.session_id, "transcript_path": "", "cwd": tracked.cwd,
                "hook_event_name": "SessionStart", "source": "startup",
                "_pixtuoid_source": "maam", "_shim_ts_ms": now_ms as u64
            }), now_ms)?;
        }
        let desired_task = if agent.state == "running" { Some(non_empty_text(&agent.detail, "Menjalankan tugas")) } else { None };
        let old_task = tracked.task.clone();
        if old_task.as_ref().map(|(_, detail)| detail) != desired_task.as_ref() {
            if let Some((tool_id, _)) = old_task {
                send_hook(office, json!({
                    "session_id": tracked.session_id, "cwd": tracked.cwd, "hook_event_name": "PostToolUse",
                    "tool_name": "", "tool_input": {}, "tool_response": {}, "tool_use_id": tool_id,
                    "_pixtuoid_source": "maam", "_shim_ts_ms": now_ms as u64
                }), now_ms)?;
                send_hook(office, json!({
                    "session_id": tracked.session_id, "cwd": tracked.cwd, "hook_event_name": "Stop",
                    "_pixtuoid_source": "maam", "_shim_ts_ms": now_ms as u64
                }), now_ms)?;
                tracked.task = None;
            }
            if let Some(detail) = desired_task {
                tracked.task_sequence = tracked.task_sequence.saturating_add(1);
                let tool_id = format!("maam-task-{}-{}", tracked.task_sequence, stable_suffix(&agent_id));
                send_hook(office, json!({
                    "session_id": tracked.session_id, "cwd": tracked.cwd, "hook_event_name": "PreToolUse",
                    "tool_name": detail, "tool_input": {}, "tool_use_id": tool_id,
                    "_pixtuoid_source": "maam", "_shim_ts_ms": now_ms as u64
                }), now_ms)?;
                tracked.task = Some((tool_id, detail));
            }
        }
    }
    let stale: Vec<String> = runtime.agents.keys().filter(|id| !seen.contains(*id)).cloned().collect();
    for id in stale {
        if let Some(mut tracked) = runtime.agents.remove(&id) {
            if let Some((tool_id, _)) = tracked.task.take() {
                send_hook(office, json!({
                    "session_id": tracked.session_id, "cwd": tracked.cwd, "hook_event_name": "PostToolUse",
                    "tool_name": "", "tool_input": {}, "tool_response": {}, "tool_use_id": tool_id,
                    "_pixtuoid_source": "maam", "_shim_ts_ms": now_ms as u64
                }), now_ms)?;
            }
            send_hook(office, json!({
                "session_id": tracked.session_id, "cwd": tracked.cwd,
                "hook_event_name": "SessionEnd", "reason": "account removed from MAAM roster",
                "_pixtuoid_source": "maam", "_shim_ts_ms": now_ms as u64
            }), now_ms)?;
        }
    }
    Ok(())
}

fn send_hook(office: &mut Office, payload: Value, now_ms: f64) -> Result<(), String> {
    let line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    office.send_hook(&line, now_ms).map(|_| ()).map_err(|error| format!("Pixtuoid menolak event agent: {error:?}"))
}
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| format!("Gagal menyiapkan frame PNG: {error}"))?;
        writer.write_image_data(rgba).map_err(|error| format!("Gagal mengodekan frame PNG: {error}"))?;
    }
    Ok(bytes)
}
fn stable_session_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("maam-{}", digest[..12].iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}
fn stable_suffix(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..5].iter().map(|byte| format!("{byte:02x}")).collect()
}
fn safe_slug(value: &str) -> String {
    let slug: String = value.chars().filter(|ch| ch.is_alphanumeric() || *ch == '-' || *ch == '_').take(36).collect();
    if slug.is_empty() { "agent".to_string() } else { slug }
}
fn non_empty_text(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() { fallback.to_string() } else { trimmed.chars().take(72).collect() }
}
