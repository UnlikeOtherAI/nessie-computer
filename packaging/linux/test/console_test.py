"""Protocol tests run on Fedora; no display or installed updater is needed."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("executor_settings", Path(__file__).parents[1] / "console/app.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConsoleProtocol(unittest.TestCase):
    def test_fixed_operations_and_boolean_policy(self):
        for operation in ("status", "check", "install", "remind"):
            self.assertEqual(module.update_arguments({"operation": operation}),
                             ["updates", operation, "--json"])
        self.assertEqual(module.update_arguments({"operation": "automatic", "enabled": False}),
                         ["updates", "automatic", "off", "--json"])

    def test_no_executable_url_channel_or_extra_arguments(self):
        for request in (
            None, [], {"operation": "setup"}, {"operation": "channel", "channel": "preview"},
            {"operation": "install", "url": "https://foreign.test/package"},
            {"operation": "status", "command": "touch /tmp/foreign"},
            {"operation": "automatic", "enabled": 1},
            {"operation": "automatic", "enabled": "off"},
        ):
            with self.assertRaises(ValueError):
                module.update_arguments(request)


if __name__ == "__main__":
    unittest.main()
