"""Exercise actual yt-dlp/OpenSSL CA loading, with no network or app imports.

Install youtube-ca-requirements.txt in a disposable venv before running.
The fixture contains only a public test CA; its private key is not needed.
"""
import os
from pathlib import Path
import socket
import ssl
import tempfile
import unittest
from unittest.mock import patch

import certifi
from yt_dlp.networking import _helper


class CertificateLoading(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="wxctx-ca-test-"))
        cls.empty_dir = cls.root / "empty-certs"
        cls.empty_dir.mkdir()
        cls.fixture = Path(__file__).with_name("test-ca.pem")
        cls.der = ssl.PEM_cert_to_DER_cert(cls.fixture.read_text())
        print(f"Offline CA test artifacts (retained): {cls.root}")

    def setUp(self):
        self.env = patch.dict(os.environ, {
            "SSL_CERT_FILE": str(self.fixture), "SSL_CERT_DIR": str(self.empty_dir),
        }, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        for name in ("socket.socket.connect", "socket.socket.connect_ex", "socket.create_connection"):
            guard = patch(name, side_effect=AssertionError("offline CA test: network forbidden"))
            guard.start()
            self.addCleanup(guard.stop)

    def context(self):
        context = _helper.make_ssl_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertIsNone(context.keylog_filename)
        return context

    def test_certifi_present_uses_its_bundle_not_ssl_cert_file(self):
        # This is the upstream default. Passing an env variable does not override certifi.
        self.assertIsNotNone(_helper.certifi)
        certs = self.context().get_ca_certs(binary_form=True)
        self.assertGreater(len(certs), 0)
        self.assertNotIn(self.der, certs)

    def test_without_certifi_loads_custom_ca_from_environment(self):
        with patch.object(_helper, "certifi", None):
            self.assertIn(self.der, self.context().get_ca_certs(binary_form=True))

    def test_without_certifi_loads_supplied_bundle(self):
        os.environ["SSL_CERT_FILE"] = certifi.where()
        with patch.object(_helper, "certifi", None):
            certs = self.context().get_ca_certs(binary_form=True)
            self.assertGreater(len(certs), 0)
            self.assertNotIn(self.der, certs)

    def test_missing_ca_does_not_disable_certificate_verification(self):
        os.environ["SSL_CERT_FILE"] = str(self.root / "absent.pem")
        with patch.object(_helper, "certifi", None):
            # An empty trust store must not be confused with a usable CA configuration.
            self.assertNotIn(self.der, self.context().get_ca_certs(binary_form=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
