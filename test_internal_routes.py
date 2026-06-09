import unittest

import app as app_module


class InternalRouteSecurityTests(unittest.TestCase):
    def setUp(self):
        self.original_token = app_module.JOEBOT_INTERNAL_TOKEN
        app_module.JOEBOT_INTERNAL_TOKEN = 'a' * 64
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.JOEBOT_INTERNAL_TOKEN = self.original_token

    def test_valid_loopback_request_is_allowed(self):
        response = self.client.get(
            '/internal/health',
            headers={'X-JoeBot-Internal': 'a' * 64},
            environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'status': 'ok'})

    def test_missing_or_wrong_token_is_rejected(self):
        missing = self.client.get(
            '/internal/health',
            environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )
        wrong = self.client.get(
            '/internal/health',
            headers={'X-JoeBot-Internal': 'b' * 64},
            environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(wrong.status_code, 401)

    def test_non_loopback_request_is_hidden(self):
        response = self.client.get(
            '/internal/health',
            headers={'X-JoeBot-Internal': 'a' * 64},
            environ_base={'REMOTE_ADDR': '203.0.113.10'}
        )

        self.assertEqual(response.status_code, 404)

    def test_proxy_forwarded_public_address_is_not_treated_as_loopback(self):
        response = self.client.get(
            '/internal/health',
            headers={
                'X-Forwarded-For': '203.0.113.10',
                'X-JoeBot-Internal': 'a' * 64
            },
            environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )

        self.assertEqual(response.status_code, 404)

    def test_old_public_internal_route_no_longer_exists(self):
        response = self.client.post(
            '/get-weather',
            json={'location': 'Nairobi'},
            environ_base={'REMOTE_ADDR': '203.0.113.10'}
        )

        self.assertEqual(response.status_code, 404)


if __name__ == '__main__':
    unittest.main()
