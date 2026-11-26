import unittest

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

    def test_invalid_and_identityless_rows_are_ignored(self):
        self.assertIsNone(bridge.task_schedule_row("not-an-object"))
        self.assertIsNone(bridge.task_schedule_row({"title": "No id"}))
        self.assertIsNone(bridge.task_run_row({"status": "running"}))
        self.assertIsNone(bridge.sanitize_task_event(b"not json"))


if __name__ == "__main__":
    unittest.main()
