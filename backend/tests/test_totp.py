"""两步验证 (TOTP) primitives."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xscript_server import totp  # noqa: E402


class TotpTest(unittest.TestCase):
    def test_rfc6238_vectors(self):
        # RFC 6238 appendix B, SHA-1 secret "12345678901234567890", 8 digits truncated to 6.
        import base64

        secret = base64.b32encode(b"12345678901234567890").decode()
        for t, code8 in ((59, "94287082"), (1111111109, "07081804"), (1234567890, "89005924"),
                         (2000000000, "69279037")):
            self.assertEqual(totp.code_at(secret, t // 30), code8[-6:])

    def test_verify_window_and_replay(self):
        s = totp.new_secret()
        now = 1_800_000_000.0
        step = int(now // 30)
        code = totp.code_at(s, step)
        self.assertEqual(totp.verify(s, code, now=now), step)
        self.assertEqual(totp.verify(s, totp.code_at(s, step - 1), now=now), step - 1)  # clock drift
        self.assertIsNone(totp.verify(s, totp.code_at(s, step - 3), now=now))
        self.assertIsNone(totp.verify(s, code, last_step=step, now=now))  # already used
        self.assertIsNone(totp.verify(s, "12ab56", now=now))
        self.assertEqual(totp.verify(s, code[:3] + " " + code[3:], now=now), step)

    def test_uri(self):
        uri = totp.provisioning_uri("ABC", "admin", "XScript 管理后台")
        self.assertTrue(uri.startswith("otpauth://totp/XScript%20%E7%AE%A1"))
        self.assertIn("secret=ABC", uri)


if __name__ == "__main__":
    unittest.main()
