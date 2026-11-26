import unittest
from unittest.mock import patch

import muse_agent_bridge as bridge


class MuseAgentBridgeSanitizationTests(unittest.TestCase):
    def test_schedule_row_keeps_only_safe_scheduler_fields(self):
        row = bridge.task_schedule_row({
            "id": "job-1",
            "title": "Morning research",
            "mode": "task",
            "enabled": True,
            "schedule_key": "daily@07:30:00",
            "next_run_at_utc": 1_800_000_000,
            "timezone": "Asia/Jakarta",
            "cadence": "daily",
            "prompt": "private task instructions",
            "secret": "never forward",
        })
        self.assertEqual(row["id"], "job-1")
        self.assertTrue(row["enabled"])
        self.assertNotIn("prompt", row)
        self.assertNotIn("secret", row)

    def test_run_row_does_not_forward_generated_result_or_error_text(self):
        row = bridge.task_run_row({
            "run_id": "run-1",
            "job_id": "job-1",
            "status": "running",
            "trigger_reason": "scheduled",
            "scheduled_for_utc": 1_800_000_000,
            "result_summary": "private agent output",
            "error_text": "private exception details",
        })
        self.assertEqual(row["status"], "running")
        self.assertNotIn("result_summary", row)
        self.assertNotIn("error_text", row)
        self.assertNotIn("summary", row)
        self.assertNotIn("error", row)

    def test_task_event_is_allowlisted_and_bounded(self):
        raw = b'{"seq":4,"event_name":"task.updated","payload":{"job_id":"job-1","status":"running","prompt":"private","result_summary":"private"}}'
        event = bridge.sanitize_task_event(raw)
        self.assertEqual(event["type"], "task_event")
        self.assertEqual(event["event"]["job_id"], "job-1")
        self.assertEqual(event["event"]["status"], "running")
        self.assertNotIn("prompt", event["event"])
        self.assertNotIn("result_summary", event["event"])


    def test_poll_reads_only_schedule_and_run_endpoints(self):
        calls = []
        events = []

        class OnePollStop:
            def __init__(self):
                self.stopped = False

            def is_set(self):
                return self.stopped

            def wait(self, _seconds):
                self.stopped = True
                return True

        class FakeGateway:
            vm_id = "test-vm"

            def __init__(self, cookies):
                self.cookies = cookies

            def call_json(self, method, body=None):
                calls.append((method, body))
                if method == "tasks.list":
                    return {"schedules": [{
                        "id": "job-1",
                        "title": "Morning research",
                        "enabled": True,
                        "schedule_key": "daily@07:30:00",
                        "next_run_at_utc": 1_800_000_000,
                        "timezone": "Asia/Jakarta",
                        "cadence": "daily",
                    }]}
                if method == "tasks.runs":
                    return {"runs": [{
                        "run_id": "run-1",
                        "job_id": "job-1",
                        "status": "running",
                        "trigger_reason": "scheduled",
                        "started_at_utc": 1_800_000_100,
                        "result_summary": "must not escape",
                    }]}
                raise AssertionError("unexpected Muse API method: " + method)

            def close(self):
                pass

        with patch.object(bridge, "Gateway", FakeGateway), patch.object(bridge, "emit", events.append):
            bridge.poll_snapshots("hatch_sess=test", OnePollStop())

        self.assertEqual(calls, [("tasks.list", None), ("tasks.runs", {"limit": bridge.MAX_RUNS})])
        snapshot = next(item for item in events if item["type"] == "snapshot")
        self.assertEqual(snapshot["schedules"][0]["nextRunAtUtc"], 1_800_000_000)
        self.assertEqual(snapshot["runs"][0]["status"], "running")
        self.assertNotIn("result_summary", snapshot["runs"][0])

    def test_task_subscription_emits_allowlisted_live_event(self):
        events = []

        class OneSubscriptionStop:
            def __init__(self):
                self.stopped = False

            def is_set(self):
                return self.stopped

            def wait(self, _seconds):
                self.stopped = True
                return True

        class FakeGateway:
            def __init__(self, cookies):
                self.cookies = cookies

            def subscribe_raw(self, method, **kwargs):
                self.assert_method = method
                kwargs["on_record"](
                    b'{"event_name":"task.updated","payload":{"job_id":"job-1","status":"running","prompt":"private"}}'
                )
                return []

            def close(self):
                pass

        with patch.object(bridge, "Gateway", FakeGateway), patch.object(bridge, "emit", events.append):
            bridge.subscribe_task_events("hatch_sess=test", OneSubscriptionStop())

        live = next(item for item in events if item["type"] == "task_event")
        self.assertEqual(live["status"], "connected")
        self.assertEqual(live["event"]["job_id"], "job-1")
        self.assertEqual(live["event"]["status"], "running")
        self.assertNotIn("prompt", live["event"])

    def test_invalid_and_identityless_rows_are_ignored(self):
        self.assertIsNone(bridge.task_schedule_row("not-an-object"))
        self.assertIsNone(bridge.task_schedule_row({"title": "No id"}))
        self.assertIsNone(bridge.task_run_row({"status": "running"}))
        self.assertIsNone(bridge.sanitize_task_event(b"not json"))


if __name__ == "__main__":
    unittest.main()
