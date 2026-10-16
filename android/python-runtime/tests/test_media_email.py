"""media.send_email opens a draft through the bridge; no mail is sent by the runtime."""
import unittest
from unittest.mock import patch

from ascript.android import media


class FakeBridge:
    def __init__(self, reply="true"):
        self.reply = reply
        self.calls = []

    def system(self, op, arg=None):
        self.calls.append((op, arg))
        return self.reply


class SendEmailTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        p = patch.object(media, "bridge", self.fake)
        p.start()
        self.addCleanup(p.stop)

    def test_builds_draft(self):
        self.assertTrue(media.send_email("a@x.com; b@y.org", "Hi", "Body", cc=["c@z.io"]))
        self.assertEqual(self.fake.calls, [("send_email", {"to": ["a@x.com", "b@y.org"], "cc": ["c@z.io"], "subject": "Hi", "body": "Body"})])

    def test_empty_and_no_mail_app(self):
        self.fake.reply = "false"
        self.assertFalse(media.send_email())
        self.assertEqual(self.fake.calls[-1][1], {"to": [], "cc": [], "subject": "", "body": ""})

    def test_invalid_address(self):
        with self.assertRaises(ValueError):
            media.send_email("nobody")
        self.assertEqual(self.fake.calls, [])


if __name__ == "__main__":
    unittest.main()
