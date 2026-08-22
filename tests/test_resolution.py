import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import requests
from PIL import Image


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from spotlight_downloader import (  # noqa: E402
    SpotlightDownloader,
    landscape_candidates,
    resolution_from_url,
)


class FakeResponse:
    def __init__(self, content=b"", status_code=200):
        self.content = content
        self.status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size):
        for offset in range(0, len(self.content), chunk_size):
            yield self.content[offset : offset + chunk_size]


class FakeSession:
    def __init__(self, responses):
        self.responses = iter(responses)

    def get(self, *_args, **_kwargs):
        return next(self.responses)


class ResolutionSelectionTests(unittest.TestCase):
    def test_extracts_resolution_from_asset_url(self):
        self.assertEqual(
            resolution_from_url("https://cdn.example/wallpaper_3840x2160.jpg"),
            (3840, 2160),
        )

    def test_prefers_exact_4k_over_other_candidates(self):
        ad = {
            "image_fullscreen_001_landscape": {
                "u": "https://cdn.example/1080.jpg",
                "w": "1920",
                "h": "1080",
            },
            "landscapeImage": {
                "asset": "https://cdn.example/wallpaper_3840x2160.jpg"
            },
            "image_fullscreen_002_landscape": {
                "u": "https://cdn.example/1440.jpg",
                "w": "2560",
                "h": "1440",
            },
        }

        candidates = landscape_candidates(ad)

        self.assertEqual(
            candidates[0]["url"],
            "https://cdn.example/wallpaper_3840x2160.jpg",
        )
        self.assertEqual(candidates[1]["url"], "https://cdn.example/1440.jpg")
        self.assertEqual(candidates[2]["url"], "https://cdn.example/1080.jpg")

    def test_uses_largest_lower_resolution_when_4k_is_absent(self):
        ad = {
            "image_fullscreen_001_landscape": {
                "u": "https://cdn.example/1080.jpg",
                "w": "1920",
                "h": "1080",
            },
            "image_fullscreen_002_landscape": {
                "u": "https://cdn.example/1440.jpg",
                "w": "2560",
                "h": "1440",
            },
        }

        candidates = landscape_candidates(ad)

        self.assertEqual(candidates[0]["url"], "https://cdn.example/1440.jpg")

    def test_ignores_legacy_empty_image_placeholders(self):
        ad = {
            "image_fullscreen_001_landscape": {
                "u": "https://cdn.example/wallpaper_1920x1080.jpg",
                "w": "1920",
                "h": "1080",
            },
            "image_fullscreen_004_landscape": {
                "u": "https://cdn.example/asset_empty.jpg",
                "w": "1920",
                "h": "1440",
            },
        }

        candidates = landscape_candidates(ad)

        self.assertEqual(
            [candidate["url"] for candidate in candidates],
            ["https://cdn.example/wallpaper_1920x1080.jpg"],
        )

    def test_download_falls_back_when_4k_asset_fails(self):
        image_bytes = io.BytesIO()
        Image.new("RGB", (1920, 1080)).save(image_bytes, format="JPEG")
        item = {
            "url": "https://cdn.example/4k.jpg",
            "title": "Fallback test",
            "candidates": [
                {
                    "url": "https://cdn.example/4k.jpg",
                    "width": 3840,
                    "height": 2160,
                },
                {
                    "url": "https://cdn.example/1080.jpg",
                    "width": 1920,
                    "height": 1080,
                },
            ],
        }

        with tempfile.TemporaryDirectory() as output:
            downloader = SpotlightDownloader(output, count=1)
            downloader.session = FakeSession(
                [FakeResponse(status_code=404), FakeResponse(image_bytes.getvalue())]
            )

            downloader.download_image(item)

            metadata_file = next(Path(output).glob("*.jpg.json"))
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            self.assertEqual(metadata["url"], "https://cdn.example/1080.jpg")
            self.assertEqual(metadata["resolution"], "1920x1080")
            self.assertFalse(metadata["is_4k"])

    def test_run_uses_lower_resolution_api_after_v4_download_failure(self):
        calls = []
        four_k = {"url": "https://cdn.example/4k.jpg", "title": "4K"}
        lower = {"url": "https://cdn.example/1080.jpg", "title": "1080p"}

        with tempfile.TemporaryDirectory() as output:
            downloader = SpotlightDownloader(output, count=1)
            downloader.get_images = lambda: [four_k]
            downloader.get_lower_resolution_images = lambda: [lower]

            def download(item):
                calls.append(item["url"])
                if item is four_k:
                    raise requests.HTTPError("4K unavailable")

            downloader.download_image = download
            downloader.run()

        self.assertEqual(
            calls,
            ["https://cdn.example/4k.jpg", "https://cdn.example/1080.jpg"],
        )


if __name__ == "__main__":
    unittest.main()
