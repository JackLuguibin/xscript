"""SMS API uses a fake provider only; tests never access device messages."""
import json
import unittest
from unittest.mock import patch

from ascript.android import sms


class FakeBridge:
    def __init__(self):
        self.permission = True
        self.calls = []
        self.rows = [{"id": 12, "body": "fixture", "type": 1, "date": 1000}]

    def system(self, op, arg):
        self.calls.append((op, arg))
        if op == "sms_has_permission":
            return str(self.permission).lower()
        if op == "sms_debug":
            return json.dumps({"client_available": True, "permission": self.permission, "read_only": True})
        if op == "sms_query":
            return json.dumps(self.rows)
        raise AssertionError(op)


class SmsTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        self.patch = patch.object(sms, "bridge", self.fake)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_query_address_and_pagination(self):
        address = "x' OR 1=1 --"
        self.assertEqual(sms.query(2, address, 7, False, 3), self.fake.rows)
        self.assertEqual(self.fake.calls[-1], ("sms_query", {
            "sms_type": 2, "address": address, "limit": 7, "order_desc": False, "offset": 3,
        }))

    def test_missing_permission_returns_empty_result(self):
        self.fake.permission = False
        self.assertFalse(sms.has_permission())
        self.assertEqual(sms.query(), [])
        self.assertIsNone(sms.get_first())
        self.assertFalse(any(op == "sms_query" for op, _ in self.fake.calls))

    def test_first_helpers(self):
        for func, kind in [(sms.get_first, 0), (sms.get_first_inbox, 1), (sms.get_first_sent, 2)]:
            self.assertEqual(func(), self.fake.rows[0])
            self.assertEqual(self.fake.calls[-1][1]["sms_type"], kind)
            self.assertEqual(self.fake.calls[-1][1]["limit"], 1)
        self.fake.rows = []
        self.assertIsNone(sms.get_first())

    def test_recent_address_and_aliases(self):
        for func in (sms.get_recent_inbox, sms.get_inbox_recent, sms.Sms.get_inbox_recent,
                     sms.SmsClass().get_recent_inbox):
            func(5)
            self.assertEqual(self.fake.calls[-1][1]["sms_type"], 1)
        sms.get_recent()
        self.assertEqual(self.fake.calls[-1][1]["limit"], 10)
        sms.get_by_address("123")
        self.assertEqual(self.fake.calls[-1][1]["limit"], 100)
        self.assertIs(sms.Sms, sms.SmsClass)
        self.assertEqual(sms.Sms.TYPE_DRAFT, 3)

    def test_inclusive_range_and_invalid_range(self):
        sms.get_range(10, 100, 1, "123")
        self.assertEqual(self.fake.calls[-1][1]["limit"], 91)
        self.assertEqual(self.fake.calls[-1][1]["offset"], 9)
        self.assertEqual(sms.get_range(-1, 9), [])
        self.assertEqual(sms.get_range(9, 1), [])

    def test_arguments_cannot_be_sql(self):
        for key in ("offset", "limit"):
            for value in (True, 1.5, "1; DROP TABLE sms"):
                with self.assertRaises(TypeError):
                    sms.query(**{key: value})
            for value in (-2147483649, 2147483648):
                with self.assertRaises(ValueError):
                    sms.query(**{key: value})
        with self.assertRaises(TypeError):
            sms.query(address=123)
        with self.assertRaises(TypeError):
            sms.query(order_desc="DESC")
        sms.query(sms_type=99)
        self.assertEqual(self.fake.calls[-1][1]["sms_type"], 0)

    def test_debug_and_permission_request(self):
        self.assertTrue(sms.debug_info()["read_only"])
        from ascript.android.system import permission
        with patch.object(permission, "request", return_value=0) as request:
            self.assertIsNone(sms.request_permission())
            request.assert_called_once_with(permission.READ_SMS)

    def test_permission_revoked_during_query(self):
        with patch.object(self.fake, "system", side_effect=lambda op, arg: "true" if op == "sms_has_permission" else json.dumps({"error": "permission_denied", "message": "revoked"})):
            self.assertEqual(sms.query(), [])
            self.assertIsNone(sms.get_first())

    def test_malformed_bridge_result_is_empty(self):
        for raw in ("{}", "null", "", "not json"):
            with self.subTest(raw=raw):
                with patch.object(self.fake, "system", side_effect=lambda op, arg: "true" if op == "sms_has_permission" else raw):
                    self.assertEqual(sms.query(), [])
                    self.assertIsNone(sms.get_first())

    def test_negative_offset_and_nonpositive_limit(self):
        for limit in (-2147483648, -5, 0):
            sms.query(limit=limit, offset=-50)
            self.assertEqual(self.fake.calls[-1][1]["offset"], 0)
            self.assertEqual(self.fake.calls[-1][1]["limit"], limit)

    def test_debug_invalid_json_defaults(self):
        with patch.object(self.fake, "system", return_value="broken"):
            self.assertEqual(sms.debug_info(), {"client_available": False, "permission": False})


if __name__ == "__main__":
    unittest.main()
