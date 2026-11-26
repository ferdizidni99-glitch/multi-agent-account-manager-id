#!/usr/bin/env python3
"""Read-only Muse VM task telemetry bridge for MAAM.

The wire client is provided by the pinned MIT-licensed muse-cli package.
Only task schedules, run status, and minimal task event identifiers are emitted.
Session cookies are accepted once over stdin; they are never written to disk or logs.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

from muse_cli.gateway import AuthError, Gateway, GatewayError


POLL_SECONDS = 12
MAX_SCHEDULES = 120
MAX_RUNS = 32


def emit(payload: dict[str, Any]) -> None:
    """Write one bounded JSON event to stdout; never write secrets."""
    try:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(line) > 512_000:
            payload = {"type": "status", "status": "attention", "message": "Telemetry payload exceeded safety limit"}
            line = json.dumps(payload, separators=(",", ":"))
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except Exception:
        # Broken stdout means MAAM has closed the pipe; the process will exit
        # when its parent terminates it.
        pass


def clean_text(value: Any, limit: int = 180) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] if value else None


def clean_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0:
        return None
    return value


def task_schedule_row(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    task_id = clean_text(row.get("id") or row.get("job_id"), 120)
    if not task_id:
        return None
    return {
        "id": task_id,
        "title": clean_text(row.get("title"), 120) or "Scheduled task",
        "mode": clean_text(row.get("mode"), 40),
        "enabled": bool(row.get("enabled", False)),
        "scheduleKey": clean_text(row.get("schedule_key"), 100),
        "nextRunAtUtc": clean_number(row.get("next_run_at_utc")),
        "timezone": clean_text(row.get("timezone"), 80),
        "cadence": clean_text(row.get("cadence"), 100),
    }


def task_run_row(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    run_id = clean_text(row.get("run_id"), 120)
    job_id = clean_text(row.get("job_id"), 120)
    if not run_id and not job_id:
        return None
    # Deliberately omit result_summary, error_text and agent-generated content.
    return {
        "runId": run_id,
        "jobId": job_id,
        "status": clean_text(row.get("status"), 40) or "unknown",
        "triggerReason": clean_text(row.get("trigger_reason"), 80),
        "scheduledForUtc": clean_number(row.get("scheduled_for_utc")),
        "startedAtUtc": clean_number(row.get("started_at_utc")),
        "finishedAtUtc": clean_number(row.get("finished_at_utc")),
    }


def sanitize_task_event(raw: bytes) -> dict[str, Any] | None:
    try:
        event = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(event, dict):
        return None
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    allowed = (
        "job_id", "jobId", "task_id", "taskId", "run_id", "runId",
        "status", "event", "event_name", "eventName", "type",
        "scheduled_for_utc", "timestamp",
    )
    result: dict[str, Any] = {}
    for key in allowed:
        value = payload.get(key, event.get(key))
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            if isinstance(value, str):
                value = clean_text(value, 100)
            if value is not None:
                result[key] = value
    if not result:
        return None
    return {"type": "task_event", "receivedAtMs": int(time.time() * 1000), "event": result}


def read_stop_signal(stop: threading.Event) -> None:
    """Wait for a stop command on stdin after the initial cookie envelope."""
    try:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except Exception:
                continue
            if isinstance(command, dict) and command.get("type") == "stop":
                stop.set()
                return
    except Exception:
        stop.set()


def poll_snapshots(cookies: str, stop: threading.Event) -> None:
    backoff = 3
    while not stop.is_set():
        gateway = None
        try:
            gateway = Gateway(cookies)
            emit({
                "type": "status",
                "status": "connected",
                "vmId": clean_text(gateway.vm_id, 100),
                "checkedAtMs": int(time.time() * 1000),
            })
            backoff = 3
            while not stop.is_set():
                schedules_doc = gateway.call_json("tasks.list")
                runs_doc = gateway.call_json("tasks.runs", body={"limit": MAX_RUNS})
                schedules = schedules_doc.get("schedules", []) if isinstance(schedules_doc, dict) else []
                runs = runs_doc.get("runs", []) if isinstance(runs_doc, dict) else []
                clean_schedules = [item for row in schedules[:MAX_SCHEDULES] if (item := task_schedule_row(row))]
                clean_runs = [item for row in runs[:MAX_RUNS] if (item := task_run_row(row))]
                emit({
                    "type": "snapshot",
                    "status": "connected",
                    "vmId": clean_text(gateway.vm_id, 100),
                    "checkedAtMs": int(time.time() * 1000),
                    "schedules": clean_schedules,
                    "runs": clean_runs,
                })
                stop.wait(POLL_SECONDS)
        except AuthError:
            emit({
                "type": "status",
                "status": "needs_auth",
                "checkedAtMs": int(time.time() * 1000),
                "message": "Muse login needs to be refreshed",
            })
            stop.wait(30)
        except GatewayError as exc:
            status = "unavailable" if getattr(exc, "status", 0) < 500 else "attention"
            emit({
                "type": "status",
                "status": status,
                "checkedAtMs": int(time.time() * 1000),
                "message": "Muse VM could not return task telemetry",
            })
            stop.wait(backoff)
            backoff = min(backoff * 2, 60)
        except Exception:
            emit({
                "type": "status",
                "status": "unavailable",
                "checkedAtMs": int(time.time() * 1000),
                "message": "Muse VM telemetry connection interrupted",
            })
            stop.wait(backoff)
            backoff = min(backoff * 2, 60)
        finally:
            if gateway is not None:
                try:
                    gateway.close()
                except Exception:
                    pass


def subscribe_task_events(cookies: str, stop: threading.Event) -> None:
    """Try Muse's task event subscription; polling remains the fallback."""
    backoff = 10
    while not stop.is_set():
        gateway = None
        try:
            gateway = Gateway(cookies)
            emit({
                "type": "subscription",
                "status": "connecting",
                "checkedAtMs": int(time.time() * 1000),
            })

            def on_record(record: bytes) -> None:
                event = sanitize_task_event(record)
                if event:
                    emit(event)

            gateway.subscribe_raw(
                "tasks.subscribe",
                body={},
                max_records=10000,
                idle_timeout=30,
                overall_timeout=120,
                on_record=on_record,
            )
            emit({
                "type": "subscription",
                "status": "reconnecting",
                "checkedAtMs": int(time.time() * 1000),
            })
            backoff = 10
        except AuthError:
            emit({"type": "subscription", "status": "needs_auth", "checkedAtMs": int(time.time() * 1000)})
            stop.wait(60)
        except Exception:
            emit({"type": "subscription", "status": "polling_fallback", "checkedAtMs": int(time.time() * 1000)})
            stop.wait(backoff)
            backoff = min(backoff * 2, 120)
        finally:
            if gateway is not None:
                try:
                    gateway.close()
                except Exception:
                    pass


def main() -> int:
    try:
        raw = sys.stdin.readline()
        config = json.loads(raw)
        cookies = config.get("cookies") if isinstance(config, dict) else None
        if not isinstance(cookies, str) or "hatch_sess=" not in cookies:
            emit({"type": "status", "status": "needs_auth", "message": "Muse session cookie is unavailable"})
            return 2
    except Exception:
        emit({"type": "status", "status": "error", "message": "Invalid telemetry startup request"})
        return 2

    stop = threading.Event()
    stopper = threading.Thread(target=read_stop_signal, args=(stop,), daemon=True)
    poller = threading.Thread(target=poll_snapshots, args=(cookies, stop), daemon=True)
    subscriber = threading.Thread(target=subscribe_task_events, args=(cookies, stop), daemon=True)
    stopper.start()
    poller.start()
    subscriber.start()
    emit({"type": "status", "status": "starting", "checkedAtMs": int(time.time() * 1000)})

    try:
        while not stop.wait(0.5):
            if not poller.is_alive():
                break
    except KeyboardInterrupt:
        stop.set()
    stop.set()
    poller.join(timeout=5)
    subscriber.join(timeout=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
