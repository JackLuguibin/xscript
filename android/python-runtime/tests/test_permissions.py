import unittest
from unittest.mock import patch

from ascript.android.system import permission


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.granted = set()
        self.result = permission.DENIED

    def system(self, op, args):
        self.calls.append((op, args))
        if op == 'permission_has':
            return str(args['key'] in self.granted).lower()
        if op == 'permission_request':
            return str(self.result)
        return '["android.permission.READ_SMS", "overlay"]'


class PermissionTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        self.patch = patch.object(permission, 'bridge', self.fake)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_declined_is_not_granted(self):
        self.assertFalse(permission.ensure(permission.SMS))
        self.assertEqual(self.fake.calls[-1][0], 'permission_request')
        self.fake.result = permission.GRANTED
        self.assertTrue(permission.ensure(permission.SMS))

    def test_existing_grant_skips_request(self):
        self.fake.granted.add(permission.LOCATION)
        self.assertTrue(permission.ensure(permission.LOCATION))
        self.assertEqual(len(self.fake.calls), 1)

    def test_timeout_and_unsupported_propagate(self):
        for code in (permission.TIMEOUT, permission.UNSUPPORTED):
            self.fake.result = code
            self.assertEqual(permission.request('sms', 2.5), code)
        self.assertEqual(self.fake.calls[-1][1], {'key': 'sms', 'timeout': 2.5})

    def test_keys_and_timeout_validate(self):
        for key in (None, '', '   ', 5):
            with self.assertRaises(ValueError):
                permission.has(key)
        for timeout in (0, -1, float('nan'), float('inf'), True, '30', 601):
            with self.assertRaises(ValueError):
                permission.request('sms', timeout)
        self.assertEqual(self.fake.calls, [])

    def test_dictionary_and_empty_bridge(self):
        self.assertIn(permission.READ_SMS, permission.list_all())
        with patch.object(self.fake, 'system', return_value=''):
            self.assertFalse(permission.has(permission.SMS))
            self.assertEqual(permission.request(permission.SMS), permission.UNSUPPORTED)
            self.assertEqual(permission.list_all(), [])
