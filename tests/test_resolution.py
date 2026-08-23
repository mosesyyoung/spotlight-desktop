import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, call, patch

import requests
from PIL import Image


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from spotlight_downloader import (  # noqa: E402
    SpotlightDownloader,
    choose_wallpaper,
    current_state_file,
    current_wallpaper_state,
    landscape_candidates,
    main,
    refresh_wallpaper,
    resolution_from_url,
    set_gnome_wallpaper,
    write_current_wallpaper_state,
)


class FakeResponse:
    def __init__(self, content=b"", status_code=200, json_data=None):
        self.content = content
        self.status_code = status_code
        self.json_data = json_data

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

    def json(self):
        return self.json_data


class FakeSession:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def get(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return next(self.responses)


def api_payload(*urls):
    return {
        "batchrsp": {
            "items": [
                {
                    "item": json.dumps(
                        {
                            "ad": {
                                "landscapeImage": {"asset": url},
                                "title": url.rsplit("/", 1)[-1],
                            }
                        }
                    )
                }
                for url in urls
            ]
        }
    }


def jpeg_bytes(size=(1920, 1080)):
    image_bytes = io.BytesIO()
    Image.new("RGB", size).save(image_bytes, format="JPEG")
    return image_bytes.getvalue()


class ResolutionSelectionTests(unittest.TestCase):
    @patch("spotlight_downloader.refresh_wallpaper")
    @patch("spotlight_downloader.SpotlightDownloader")
    def test_refresh_option_runs_scheduled_refresh(self, downloader, refresh):
        app = downloader.return_value

        main(["--refresh", "--output", "/archive"])

        refresh.assert_called_once_with(app)
        app.run.assert_not_called()
        app.session.close.assert_called_once_with()

    @patch("spotlight_downloader.set_gnome_wallpaper")
    def test_refresh_sets_a_newly_downloaded_wallpaper(self, set_wallpaper):
        image = Path("/archive/new.jpg")
        downloader = Mock()
        downloader.run.return_value = [image]
        set_wallpaper.return_value = image

        result = refresh_wallpaper(downloader)

        self.assertEqual(result, image)
        set_wallpaper.assert_called_once_with(image)

    @patch("spotlight_downloader.set_gnome_wallpaper")
    def test_refresh_leaves_wallpaper_unchanged_without_new_images(
        self, set_wallpaper
    ):
        downloader = Mock()
        downloader.run.return_value = []
        output = io.StringIO()

        with redirect_stdout(output):
            result = refresh_wallpaper(downloader)

        self.assertIsNone(result)
        set_wallpaper.assert_not_called()
        self.assertIn("wallpaper unchanged", output.getvalue())

    @patch("spotlight_downloader.SpotlightDownloader")
    @patch("spotlight_downloader.set_gnome_wallpaper")
    def test_explicit_wallpaper_does_not_start_downloader(
        self, set_wallpaper, downloader
    ):
        main(["--set-wallpaper", "/tmp/wallpaper.jpg"])

        set_wallpaper.assert_called_once_with("/tmp/wallpaper.jpg")
        downloader.assert_not_called()

    def test_version_option_reports_release_version(self):
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            main(["--version"])

        self.assertEqual(raised.exception.code, 0)
        self.assertIn("1.2.0", output.getvalue())

    def test_current_state_uses_xdg_directory_and_existing_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            state_home = temporary_path / "state"
            image = temporary_path / "风景.jpg"
            image.write_bytes(b"image")
            metadata_file = Path(f"{image}.json")
            metadata_file.write_text(
                json.dumps(
                    {
                        "title": "九寨沟之秋",
                        "description": "五彩斑斓的湖泊与森林。",
                        "copyright": "© Photographer",
                        "url": "https://cdn.example/wallpaper.jpg",
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"XDG_STATE_HOME": str(state_home)}):
                state_file = write_current_wallpaper_state(image)
                expected_file = current_state_file()

            state = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertEqual(state_file, expected_file)
            self.assertEqual(state["image"], str(image.resolve()))
            self.assertEqual(state["metadata"], str(metadata_file.resolve()))
            self.assertEqual(state["title"], "九寨沟之秋")
            self.assertEqual(state["description"], "五彩斑斓的湖泊与森林。")
            self.assertNotIn("location", state)
            self.assertIn("+", state["updated_at"])
            self.assertEqual(state_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(state_file.parent.stat().st_mode & 0o777, 0o700)
            self.assertFalse(state_file.with_name("current.json.tmp").exists())
            self.assertEqual(
                list(state_file.parent.glob(".current.json.*.tmp")),
                [],
            )

    def test_current_state_omits_missing_metadata_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "wallpaper.jpg"
            image.write_bytes(b"image")

            state = current_wallpaper_state(image)

        self.assertEqual(state["image"], str(image.resolve()))
        self.assertNotIn("metadata", state)
        self.assertNotIn("title", state)
        self.assertNotIn("location", state)

    def test_invalid_metadata_does_not_block_current_state_update(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            image = temporary_path / "wallpaper.jpg"
            image.write_bytes(b"image")
            Path(f"{image}.json").write_text("not JSON", encoding="utf-8")
            state_file = temporary_path / "state/current.json"
            warnings = io.StringIO()

            with redirect_stderr(warnings):
                write_current_wallpaper_state(image, state_file)

            state = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertEqual(state["image"], str(image.resolve()))
            self.assertNotIn("metadata", state)
            self.assertIn("cannot read wallpaper metadata", warnings.getvalue())

    def test_systemd_timer_runs_hourly_refresh_service(self):
        project_root = Path(__file__).resolve().parents[1]
        timer = (project_root / "systemd/spotlight-desktop.timer").read_text()
        service = (project_root / "systemd/spotlight-desktop.service").read_text()

        self.assertIn("OnCalendar=hourly", timer)
        self.assertIn("Persistent=true", timer)
        self.assertIn("spotlight_downloader.py --refresh", service)

    def test_gnome_extension_targets_shell_50_and_monitors_current_state(self):
        project_root = Path(__file__).resolve().parents[1]
        extension_directory = (
            project_root
            / "gnome-extension"
            / "spotlight-desktop@mosesyyoung"
        )
        metadata = json.loads(
            (extension_directory / "metadata.json").read_text(encoding="utf-8")
        )
        source = (extension_directory / "extension.js").read_text(
            encoding="utf-8"
        )

        self.assertEqual(metadata["uuid"], "spotlight-desktop@mosesyyoung")
        self.assertEqual(metadata["shell-version"], ["50"])
        self.assertIn("GLib.get_user_state_dir()", source)
        self.assertIn("monitor_directory", source)
        self.assertIn("this._monitor?.cancel()", source)
        self.assertNotIn("timeout_add", source)

    def test_gnome_extension_installer_uses_user_data_directory(self):
        project_root = Path(__file__).resolve().parents[1]
        installer = project_root / "scripts/install-gnome-extension.sh"

        with tempfile.TemporaryDirectory() as temporary:
            data_home = Path(temporary) / "data"
            environment = {**os.environ, "XDG_DATA_HOME": str(data_home)}
            result = subprocess.run(
                [str(installer)],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
            installed = (
                data_home
                / "gnome-shell/extensions"
                / "spotlight-desktop@mosesyyoung"
            )

            self.assertTrue((installed / "metadata.json").is_file())
            self.assertTrue((installed / "extension.js").is_file())
            self.assertTrue((installed / "stylesheet.css").is_file())
            self.assertIn("gnome-extensions enable", result.stdout)

    def test_choose_wallpaper_uses_supported_images_only(self):
        with tempfile.TemporaryDirectory() as output:
            output_path = Path(output)
            image = output_path / "wallpaper.JPG"
            image.write_bytes(b"image")
            (output_path / "wallpaper.jpg.json").write_text("{}")

            self.assertEqual(choose_wallpaper(output_path), image)

    def test_choose_wallpaper_fails_when_archive_has_no_images(self):
        with tempfile.TemporaryDirectory() as output:
            with self.assertRaisesRegex(RuntimeError, "no wallpaper images"):
                choose_wallpaper(output)

    @patch("spotlight_downloader.write_current_wallpaper_state")
    @patch("spotlight_downloader.subprocess.run")
    def test_sets_gnome_light_and_dark_wallpapers(self, run, write_state):
        with tempfile.TemporaryDirectory() as output:
            image = Path(output) / "wallpaper with spaces.jpg"
            image.write_bytes(b"image")
            uri = image.resolve().as_uri()
            run.side_effect = [
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 0, repr(uri), ""),
                subprocess.CompletedProcess([], 0, repr(uri), ""),
            ]

            result = set_gnome_wallpaper(image)

        self.assertEqual(result, image.resolve())
        write_state.assert_called_once_with(image.resolve())
        self.assertEqual(
            run.call_args_list,
            [
                call(
                    [
                        "gsettings",
                        "set",
                        "org.gnome.desktop.background",
                        "picture-uri",
                        uri,
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                ),
                call(
                    [
                        "gsettings",
                        "set",
                        "org.gnome.desktop.background",
                        "picture-uri-dark",
                        uri,
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                ),
                call(
                    [
                        "gsettings",
                        "get",
                        "org.gnome.desktop.background",
                        "picture-uri",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                ),
                call(
                    [
                        "gsettings",
                        "get",
                        "org.gnome.desktop.background",
                        "picture-uri-dark",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                ),
            ],
        )

    @patch("spotlight_downloader.write_current_wallpaper_state")
    @patch("spotlight_downloader.subprocess.run")
    def test_detects_dconf_commit_warning_with_success_status(
        self, run, write_state
    ):
        run.return_value = subprocess.CompletedProcess(
            [],
            0,
            "",
            "dconf-WARNING: failed to commit changes: Could not connect",
        )
        with tempfile.TemporaryDirectory() as output:
            image = Path(output) / "wallpaper.jpg"
            image.write_bytes(b"image")

            with self.assertRaisesRegex(RuntimeError, "could not commit"):
                set_gnome_wallpaper(image)

        self.assertEqual(run.call_count, 1)
        write_state.assert_not_called()

    @patch("spotlight_downloader.subprocess.run")
    def test_successful_wallpaper_update_writes_current_state(self, run):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            image = temporary_path / "wallpaper.jpg"
            image.write_bytes(b"image")
            Path(f"{image}.json").write_text(
                json.dumps({"title": "Current Spotlight"}),
                encoding="utf-8",
            )
            uri = image.resolve().as_uri()
            run.side_effect = [
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 0, repr(uri), ""),
                subprocess.CompletedProcess([], 0, repr(uri), ""),
            ]

            state_home = temporary_path / "state"
            with patch.dict(os.environ, {"XDG_STATE_HOME": str(state_home)}):
                set_gnome_wallpaper(image)

            state_file = state_home / "spotlight-desktop/current.json"
            state = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertEqual(state["image"], str(image.resolve()))
            self.assertEqual(state["title"], "Current Spotlight")

    @patch("spotlight_downloader.write_current_wallpaper_state")
    @patch("spotlight_downloader.subprocess.run")
    def test_detects_wallpaper_setting_that_was_not_applied(
        self, run, write_state
    ):
        run.side_effect = [
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, repr("file:///old.jpg"), ""),
        ]
        with tempfile.TemporaryDirectory() as output:
            image = Path(output) / "wallpaper.jpg"
            image.write_bytes(b"image")

            with self.assertRaisesRegex(RuntimeError, "was not applied"):
                set_gnome_wallpaper(image)

        write_state.assert_not_called()

    @patch("spotlight_downloader.subprocess.run")
    def test_rejects_missing_wallpaper_before_changing_settings(self, run):
        with self.assertRaisesRegex(RuntimeError, "does not exist"):
            set_gnome_wallpaper("/missing/wallpaper.jpg")
        run.assert_not_called()

    def test_get_images_fetches_more_than_four_in_batches(self):
        first_batch = [f"https://cdn.example/{number}_3840x2160.jpg" for number in range(4)]
        second_batch = [
            "https://cdn.example/3_3840x2160.jpg",
            "https://cdn.example/4_3840x2160.jpg",
            "https://cdn.example/5_3840x2160.jpg",
        ]

        with tempfile.TemporaryDirectory() as output:
            downloader = SpotlightDownloader(output, count=6)
            downloader.session.close()
            downloader.session = FakeSession(
                [
                    FakeResponse(json_data=api_payload(*first_batch)),
                    FakeResponse(json_data=api_payload(*second_batch)),
                ]
            )

            images = downloader.get_images()

        self.assertEqual(len(images), 6)
        self.assertEqual(len({image["url"] for image in images}), 6)
        self.assertEqual(
            [call[1]["params"]["bcnt"] for call in downloader.session.calls],
            [4, 2],
        )

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
                [FakeResponse(status_code=404), FakeResponse(jpeg_bytes())]
            )

            downloader.download_image(item)

            metadata_file = next(Path(output).glob("*.jpg.json"))
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            self.assertEqual(metadata["url"], "https://cdn.example/1080.jpg")
            self.assertEqual(metadata["resolution"], "1920x1080")
            self.assertFalse(metadata["is_4k"])

    def test_scans_image_metadata_and_skips_known_candidate(self):
        primary_url = "https://cdn.example/4k.jpg"
        fallback_url = "https://cdn.example/1080.jpg"

        with tempfile.TemporaryDirectory() as output:
            output_path = Path(output)
            image_file = output_path / "existing.jpg"
            image_file.write_bytes(b"existing image")
            (output_path / "existing.jpg.json").write_text(
                json.dumps(
                    {
                        "url": fallback_url,
                        "candidates": [
                            {"url": primary_url},
                            {"url": fallback_url},
                        ],
                        "file": image_file.name,
                    }
                ),
                encoding="utf-8",
            )

            output_log = io.StringIO()
            with redirect_stdout(output_log):
                downloader = SpotlightDownloader(output, count=1)
            downloader.session.close()
            downloader.session = FakeSession([])
            downloader.download_image(
                {
                    "url": primary_url,
                    "candidates": [{"url": primary_url}],
                }
            )

            self.assertEqual(downloader.session.calls, [])
            self.assertIn(
                "Loaded 1 metadata JSON file into download history",
                output_log.getvalue(),
            )

    def test_ignores_invalid_metadata_and_downloads_image(self):
        url = "https://cdn.example/new.jpg"

        with tempfile.TemporaryDirectory() as output:
            output_path = Path(output)
            (output_path / "broken.jpg").write_bytes(b"existing image")
            (output_path / "broken.jpg.json").write_text(
                "not JSON",
                encoding="utf-8",
            )

            warnings = io.StringIO()
            with redirect_stderr(warnings):
                downloader = SpotlightDownloader(output, count=1)
            downloader.session.close()
            downloader.session = FakeSession([FakeResponse(jpeg_bytes())])
            downloader.download_image({"url": url})

            self.assertEqual(len(downloader.session.calls), 1)
            self.assertIn("ignoring invalid", warnings.getvalue())

    def test_new_download_is_added_to_history_without_database_file(self):
        url = "https://cdn.example/new.jpg"

        with tempfile.TemporaryDirectory() as output:
            output_path = Path(output)
            downloader = SpotlightDownloader(output, count=1)
            downloader.session.close()
            downloader.session = FakeSession([FakeResponse(jpeg_bytes())])

            image_file = downloader.download_image({"url": url})
            duplicate = downloader.download_image({"url": url})

            self.assertEqual(image_file.parent, output_path)
            self.assertTrue(image_file.is_file())
            self.assertIsNone(duplicate)
            self.assertEqual(len(downloader.session.calls), 1)
            self.assertEqual(len(list(output_path.glob("*.jpg.json"))), 1)
            self.assertFalse((output_path / "downloaded.json").exists())

    def test_metadata_without_its_image_does_not_block_redownload(self):
        url = "https://cdn.example/missing.jpg"

        with tempfile.TemporaryDirectory() as output:
            output_path = Path(output)
            (output_path / "missing.jpg.json").write_text(
                json.dumps({"url": url, "file": "missing.jpg"}),
                encoding="utf-8",
            )

            downloader = SpotlightDownloader(output, count=1)
            downloader.session.close()
            downloader.session = FakeSession([FakeResponse(jpeg_bytes())])
            downloader.download_image({"url": url})

            self.assertEqual(len(downloader.session.calls), 1)

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

    def test_run_returns_only_files_downloaded_in_this_run(self):
        known = {"url": "https://cdn.example/known.jpg"}
        new = {"url": "https://cdn.example/new.jpg"}
        new_file = Path("/archive/new.jpg")

        with tempfile.TemporaryDirectory() as output:
            downloader = SpotlightDownloader(output, count=2)
            downloader.get_images = lambda: [known, new]
            downloader.download_image = Mock(side_effect=[None, new_file])

            downloaded_files = downloader.run()

        self.assertEqual(downloaded_files, [new_file])


if __name__ == "__main__":
    unittest.main()
