from django.test import SimpleTestCase


class ConsumerSmokeTests(SimpleTestCase):
    def test_consumer_module_importable(self):
        try:
            from game.consumers import GameConsumer  # noqa: F401
        except Exception as e:
            self.fail(f"Importing GameConsumer failed: {e}")

    def test_utils_importable(self):
        try:
            from game import utils  # noqa: F401
        except Exception as e:
            self.fail(f"Importing game.utils failed: {e}")
