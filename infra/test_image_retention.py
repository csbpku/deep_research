"""Policy regression checks; no Docker daemon or deletion required."""
import datetime as dt
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("retention", pathlib.Path(__file__).with_name("image-retention.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PolicyTest(unittest.TestCase):
    def test_preserves_latest_two_distinct_versions_custom_and_recent(self):
        now = dt.datetime(2026, 10, 21, tzinfo=dt.timezone.utc)

        def image(ident, age, tags):
            return {"Id": ident, "Created": (now - dt.timedelta(days=age)).isoformat(),
                    "RepoTags": tags}

        repo = "ghcr.io/csbpku/deep-research/web:"
        images = [image("one", 20, [repo + "aaaaaaa", repo + "aaaaaaaa"]),
                  image("two", 21, [repo + "bbbbbbb"]),
                  image("old", 30, [repo + "ccccccc"]),
                  image("custom", 60, ["deep-research-web:neat-20261020"]),
                  image("alias", 60, [repo + "latest"]),
                  image("dangling", 60, None)]
        self.assertEqual([row[2] for row in module.candidates(images, now)], ["old"])
        images.append(image("recent", 1, [repo + "ddddddd"]))
        self.assertNotIn("recent", [row[2] for row in module.candidates(images, now)])


if __name__ == "__main__":
    unittest.main()
