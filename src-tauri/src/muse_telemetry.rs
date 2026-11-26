use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::session_manager::SessionManager;

struct MuseTelemetryWorker {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct MuseTelemetryState {
    workers: Mutex<HashMap<String, MuseTelemetryWorker>>,
    latest: Mutex<HashMap<String, Value>>,
}

impl MuseTelemetryState {
    fn account_id(uuid: &str) -> String {
        format!("muse:{}", uuid)
    }

    fn latest_snapshots(&self) -> Result<Vec<Value>, String> {
        let latest = self.latest.lock().map_err(|_| "Muse telemetry state is unavailable".to_string())?;
        Ok(latest.values().cloned().collect())
    }
}

impl Drop for MuseTelemetryState {
    fn drop(&mut self) {
        if let Ok(workers) = self.workers.get_mut() {
            for worker in workers.values_mut() {
                let _ = worker.child.kill();
                let _ = worker.child.wait();
            }
        }
    }
}

#[tauri::command]
pub async fn start_muse_agent_telemetry(
    app: AppHandle,
    manager: State<'_, std::sync::Arc<SessionManager>>,
    telemetry: State<'_, MuseTelemetryState>,
    uuid: String,
) -> Result<(), String> {
    let parsed_uuid = Uuid::parse_str(uuid.trim())
        .map_err(|_| "UUID akun Muse tidak valid".to_string())?;
    let uuid = parsed_uuid.to_string();
    let account_id = MuseTelemetryState::account_id(&uuid);

    {
        let mut workers = telemetry.workers.lock()
            .map_err(|_| "Muse telemetry state is unavailable".to_string())?;
        if let Some(worker) = workers.get_mut(&account_id) {
            match worker.child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) => { workers.remove(&account_id); }
                Err(_) => { workers.remove(&account_id); }
            }
        }
    }

    // Read cookies from the account's existing MAAM WebView profile. They are
    // passed to the bridge through stdin only; they are not saved to disk or
    // included in process arguments, logs, or frontend events.
    let cookies = manager.muse_telemetry_cookie_header(&app, &uuid).await?;
    let resource_dir = app.path().resource_dir()
        .map_err(|_| "Direktori resource MAAM tidak tersedia".to_string())?;
    let bridge_name = if cfg!(windows) { "muse-agent-bridge.exe" } else { "muse-agent-bridge" };
    let bridge_path = resource_dir.join("sidecars").join(bridge_name);
    if !bridge_path.is_file() {
        return Err("Muse telemetry bridge belum tersedia pada build ini".to_string());
    }

    let mut child = Command::new(&bridge_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Tidak dapat menjalankan Muse telemetry bridge".to_string())?;
    let mut child_stdin = child.stdin.take()
        .ok_or_else(|| "Muse telemetry bridge tidak menerima input".to_string())?;
    let config = json!({ "accountId": account_id, "cookies": cookies });
    serde_json::to_writer(&mut child_stdin, &config)
        .map_err(|_| "Gagal mengirim sesi ke Muse telemetry bridge".to_string())?;
    child_stdin.write_all(b"\n")
        .and_then(|_| child_stdin.flush())
        .map_err(|_| "Gagal memulai Muse telemetry bridge".to_string())?;
    let stdout = child.stdout.take()
        .ok_or_else(|| "Muse telemetry bridge tidak menghasilkan output".to_string())?;

    {
        let mut workers = telemetry.workers.lock()
            .map_err(|_| "Muse telemetry state is unavailable".to_string())?;
        if workers.contains_key(&account_id) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        workers.insert(account_id.clone(), MuseTelemetryWorker {
            child,
            stdin: child_stdin,
        });
    }

    let core_account_id = account_id.clone();
    let core_uuid = uuid.clone();
    let app_for_reader = app.clone();
    let latest_state = app.state::<MuseTelemetryState>();
    // Tauri State is borrow-scoped; the managed value itself remains alive for
    // the app lifetime, so capture the app handle and re-resolve it per event.
    drop(latest_state);
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break; };
            if line.len() > 512_000 { continue; }
            let Ok(mut event) = serde_json::from_str::<Value>(&line) else { continue; };
            let Some(object) = event.as_object_mut() else { continue; };
            object.insert("accountKey".to_string(), json!({
                "providerId": "muse",
                "uuid": core_uuid
            }));
            let event_type = object.get("type").and_then(Value::as_str).unwrap_or("");
            if matches!(event_type, "snapshot" | "status" | "subscription") {
                if let Some(state) = app_for_reader.try_state::<MuseTelemetryState>() {
                    if let Ok(mut latest) = state.latest.lock() {
                        latest.insert(core_account_id.clone(), event.clone());
                    }
                }
            }
            let _ = app_for_reader.emit("muse-agent-telemetry", event);
        }
        if let Some(state) = app_for_reader.try_state::<MuseTelemetryState>() {
            if let Ok(mut workers) = state.workers.lock() {
                if let Some(mut worker) = workers.remove(&core_account_id) {
                    let _ = worker.child.wait();
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn get_muse_agent_telemetry(
    telemetry: State<'_, MuseTelemetryState>,
) -> Result<Vec<Value>, String> {
    telemetry.latest_snapshots()
}

#[tauri::command]
pub fn stop_muse_agent_telemetry(
    telemetry: State<'_, MuseTelemetryState>,
    uuid: String,
) -> Result<(), String> {
    let parsed_uuid = Uuid::parse_str(uuid.trim())
        .map_err(|_| "UUID akun Muse tidak valid".to_string())?;
    let account_id = MuseTelemetryState::account_id(&parsed_uuid.to_string());
    let mut workers = telemetry.workers.lock()
        .map_err(|_| "Muse telemetry state is unavailable".to_string())?;
    if let Some(mut worker) = workers.remove(&account_id) {
        let _ = writeln!(worker.stdin, "{{\"type\":\"stop\"}}");
        let _ = worker.stdin.flush();
        let _ = worker.child.kill();
        let _ = worker.child.wait();
    }
    Ok(())
}
