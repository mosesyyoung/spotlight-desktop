#!/usr/bin/env python3

import argparse
import ast
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import requests
from PIL import Image, UnidentifiedImageError
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


API_URL = "https://fd.api.iris.microsoft.com/v4/api/selection"
FALLBACK_API_URL = "https://arc.msn.com/v3/Delivery/Placement"
PREFERRED_RESOLUTION = (3840, 2160)
API_BATCH_SIZE = 4
MAX_STALE_BATCHES = 5
RESOLUTION_PATTERN = re.compile(r"(?<!\d)(\d{3,5})x(\d{3,5})(?!\d)", re.IGNORECASE)
WALLPAPER_EXTENSIONS = frozenset((".jpg", ".jpeg", ".png", ".webp"))
GNOME_BACKGROUND_SCHEMA = "org.gnome.desktop.background"
CURRENT_STATE_DIRECTORY = "spotlight-desktop"
CURRENT_STATE_FILENAME = "current.json"
__version__ = "1.2.0"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}


def choose_wallpaper(directory):
    """Choose a random wallpaper image from a directory."""
    directory = Path(directory).expanduser()
    try:
        images = sorted(
            path
            for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in WALLPAPER_EXTENSIONS
        )
    except OSError as exc:
        raise RuntimeError(
            f"cannot read wallpaper directory {directory}: {exc}"
        ) from exc

    if not images:
        raise RuntimeError(f"no wallpaper images found in {directory}")
    return random.choice(images)


def current_state_file():
    """Return the XDG-compliant path for the current wallpaper state."""
    state_home = os.environ.get("XDG_STATE_HOME")
    if state_home:
        state_directory = Path(state_home).expanduser()
    else:
        state_directory = Path.home() / ".local" / "state"
    return state_directory / CURRENT_STATE_DIRECTORY / CURRENT_STATE_FILENAME


def metadata_file_for_image(image):
    """Return the per-image metadata path used by the download archive."""
    image = Path(image)
    return image.with_name(f"{image.name}.json")


def current_wallpaper_state(image):
    """Build the state exposed to desktop integrations for one image."""
    image = Path(image).expanduser().resolve()
    metadata_file = metadata_file_for_image(image)
    metadata = None

    if metadata_file.is_file():
        try:
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                raise ValueError("expected a JSON object")
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(
                f"Warning: cannot read wallpaper metadata {metadata_file}: {exc}",
                file=sys.stderr,
            )
            metadata = None

    state = {
        "image": str(image),
        "updated_at": datetime.now().astimezone().isoformat(),
    }
    if metadata is not None:
        state["metadata"] = str(metadata_file)
        for field in ("title", "description", "copyright", "location", "url"):
            value = metadata.get(field)
            if isinstance(value, str) and value.strip():
                state[field] = value
    return state


def write_current_wallpaper_state(image, state_file=None):
    """Atomically write current.json after a wallpaper was applied."""
    image = Path(image).expanduser().resolve()
    if not image.is_file():
        raise RuntimeError(f"wallpaper image does not exist: {image}")

    state_file = Path(state_file) if state_file else current_state_file()
    state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp_file = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=state_file.parent,
            prefix=f".{state_file.name}.",
            suffix=".tmp",
            delete=False,
        ) as output_file:
            temp_file = Path(output_file.name)
            json.dump(
                current_wallpaper_state(image),
                output_file,
                ensure_ascii=False,
                indent=2,
            )
            output_file.write("\n")
            output_file.flush()
            os.fsync(output_file.fileno())
        temp_file.chmod(0o600)
        temp_file.replace(state_file)
    finally:
        if temp_file is not None:
            temp_file.unlink(missing_ok=True)

    return state_file


def set_gnome_wallpaper(image):
    """Set an image for both GNOME's light and dark wallpaper settings."""
    image = Path(image).expanduser().resolve()
    if not image.is_file():
        raise RuntimeError(f"wallpaper image does not exist: {image}")

    image_uri = image.as_uri()
    try:
        for key in ("picture-uri", "picture-uri-dark"):
            result = subprocess.run(
                [
                    "gsettings",
                    "set",
                    GNOME_BACKGROUND_SCHEMA,
                    key,
                    image_uri,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            if result.stderr.strip():
                raise RuntimeError(
                    "GNOME could not commit the wallpaper setting: "
                    f"{result.stderr.strip()}"
                )

        for key in ("picture-uri", "picture-uri-dark"):
            result = subprocess.run(
                ["gsettings", "get", GNOME_BACKGROUND_SCHEMA, key],
                check=True,
                capture_output=True,
                text=True,
            )
            try:
                current_uri = ast.literal_eval(result.stdout.strip())
            except (SyntaxError, ValueError) as exc:
                raise RuntimeError(
                    f"could not verify GNOME wallpaper setting {key}"
                ) from exc
            if current_uri != image_uri:
                raise RuntimeError(
                    f"GNOME wallpaper setting {key} was not applied; "
                    "run this command from an active GNOME desktop session"
                )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "gsettings is not installed; GNOME wallpaper cannot be changed"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "GNOME rejected the wallpaper setting; run this command from "
            "an active GNOME desktop session"
        ) from exc

    write_current_wallpaper_state(image)
    print("Wallpaper:", image)
    return image


def refresh_wallpaper(downloader):
    """Download new images and apply one only when the archive changed."""
    downloaded_files = downloader.run()
    if not downloaded_files:
        print("No new wallpapers found; wallpaper unchanged")
        return None

    wallpaper = random.choice(downloaded_files)
    return set_gnome_wallpaper(wallpaper)


def parse_dimension(value):
    """Return a positive integer dimension, or None for invalid API data."""
    try:
        dimension = int(value)
    except (TypeError, ValueError):
        return None
    return dimension if dimension > 0 else None


def resolution_from_url(url):
    """Extract a resolution hint such as 3840x2160 from an asset URL."""
    matches = RESOLUTION_PATTERN.findall(url or "")
    if not matches:
        return None, None
    return tuple(map(int, matches[-1]))


def make_candidate(asset):
    """Normalize a Spotlight asset object into a resolution candidate."""
    if isinstance(asset, str):
        url = asset
        width = height = None
    elif isinstance(asset, dict):
        url = asset.get("asset") or asset.get("u") or asset.get("url")
        width = parse_dimension(asset.get("width") or asset.get("w"))
        height = parse_dimension(asset.get("height") or asset.get("h"))
    else:
        return None

    if not isinstance(url, str) or not url.lower().startswith("https://"):
        return None
    filename = Path(urlsplit(url).path).name.lower()
    if re.search(r"(?:^|_)empty\.(?:jpe?g|png)$", filename):
        return None
    if width is None or height is None:
        hinted_width, hinted_height = resolution_from_url(url)
        width = width or hinted_width
        height = height or hinted_height
    return {"url": url, "width": width, "height": height}


def candidate_rank(candidate):
    """Rank exact 4K first, followed by the largest lower-resolution asset."""
    width = candidate.get("width")
    height = candidate.get("height")
    if not width or not height:
        return (1, 0)

    area = width * height
    if (width, height) == PREFERRED_RESOLUTION:
        return (3, area)
    return (2, area)


def landscape_candidates(ad):
    """Collect and rank landscape assets from v4 and legacy API shapes."""
    assets = []
    if "landscapeImage" in ad:
        assets.append(ad["landscapeImage"])

    legacy_keys = sorted(
        key
        for key in ad
        if re.fullmatch(r"image_fullscreen_\d+_landscape", key)
    )
    assets.extend(ad[key] for key in legacy_keys)

    candidates = []
    seen_urls = set()
    for asset in assets:
        candidate = make_candidate(asset)
        if candidate and candidate["url"] not in seen_urls:
            seen_urls.add(candidate["url"])
            candidates.append(candidate)
    return sorted(candidates, key=candidate_rank, reverse=True)


def create_session():
    """Create a session resilient to transient Microsoft CDN failures."""
    retry = Retry(
        total=5,
        connect=5,
        read=5,
        status=5,
        backoff_factor=1,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(("GET",)),
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


class SpotlightDownloader:
    def __init__(self, output, country="CN", locale="zh-CN", count=10):
        self.output = Path(output)
        self.country = country
        self.locale = locale
        self.count = count
        self.session = create_session()

        self.output.mkdir(parents=True, exist_ok=True)
        self.history = self.load_history()

    @staticmethod
    def metadata_urls(metadata):
        """Return every asset URL represented by an image metadata record."""
        urls = []
        url = metadata.get("url")
        if isinstance(url, str):
            urls.append(url)

        candidates = metadata.get("candidates", [])
        if isinstance(candidates, list):
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                candidate_url = candidate.get("url")
                if isinstance(candidate_url, str) and candidate_url not in urls:
                    urls.append(candidate_url)
        return urls

    def load_history(self):
        """Build download history from per-image metadata JSON files."""
        history = {}
        loaded_metadata = 0
        for metadata_file in sorted(self.output.glob("*.jpg.json")):
            try:
                metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                print(
                    f"Warning: ignoring invalid {metadata_file}: {exc}",
                    file=sys.stderr,
                )
                continue

            if not isinstance(metadata, dict):
                print(
                    f"Warning: ignoring invalid {metadata_file}: expected an object",
                    file=sys.stderr,
                )
                continue

            image_file = metadata_file.with_suffix("")
            if not image_file.is_file():
                continue

            urls = self.metadata_urls(metadata)
            if not urls:
                continue

            for url in urls:
                history[url] = image_file
            loaded_metadata += 1

        file_label = "file" if loaded_metadata == 1 else "files"
        print(
            f"Loaded {loaded_metadata} metadata JSON {file_label} "
            "into download history"
        )
        return history

    def add_to_history(self, metadata, image_file):
        for url in self.metadata_urls(metadata):
            self.history[url] = image_file

    def get_images(self):
        print("Query Spotlight API...")
        images = []
        seen_urls = set()
        stale_batches = 0

        while len(images) < self.count and stale_batches < MAX_STALE_BATCHES:
            batch_count = min(API_BATCH_SIZE, self.count - len(images))
            params = {
                "placement": "88000820",
                "bcnt": batch_count,
                "country": self.country,
                "locale": self.locale,
                "fmt": "json",
            }
            response = self.session.get(API_URL, params=params, timeout=(20, 30))
            response.raise_for_status()

            try:
                items = response.json()["batchrsp"]["items"]
            except (requests.exceptions.JSONDecodeError, KeyError, TypeError) as exc:
                raise RuntimeError(
                    "Spotlight API returned an unexpected response"
                ) from exc

            new_images = []
            for image in self.parse_images(items):
                if image["url"] not in seen_urls:
                    seen_urls.add(image["url"])
                    new_images.append(image)
            if new_images:
                for image in new_images:
                    images.append(image)
                    if len(images) == self.count:
                        break
                stale_batches = 0
                if self.count > API_BATCH_SIZE:
                    print(f"Collected {len(images)}/{self.count} unique images")
            else:
                stale_batches += 1

        if len(images) < self.count:
            print(
                f"Warning: requested {self.count} images, but only found "
                f"{len(images)} unique images after {MAX_STALE_BATCHES} "
                "batches without new results",
                file=sys.stderr,
            )
        return images

    def get_lower_resolution_images(self):
        params = {
            "pid": "338387",
            "fmt": "json",
            "ua": "WindowsShellClient/0",
            "cdm": "1",
            "pl": self.locale,
            "lc": self.locale,
            "ctry": self.country,
            "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

        print("Query lower-resolution Spotlight API...")
        response = self.session.get(
            FALLBACK_API_URL, params=params, timeout=(20, 30)
        )
        response.raise_for_status()

        try:
            items = response.json()["batchrsp"]["items"]
        except (requests.exceptions.JSONDecodeError, KeyError, TypeError) as exc:
            raise RuntimeError(
                "Lower-resolution Spotlight API returned an unexpected response"
            ) from exc

        return self.parse_images(items)

    @staticmethod
    def parse_images(items):
        result = []
        for item in items:
            try:
                raw_item = item["item"]
                obj = json.loads(raw_item) if isinstance(raw_item, str) else raw_item
                ad = obj.get("ad", {})
                candidates = landscape_candidates(ad)
            except (KeyError, TypeError, json.JSONDecodeError):
                continue

            if candidates:
                legacy_title = ad.get("title_text", {})
                legacy_copyright = ad.get("copyright_text", {})
                result.append(
                    {
                        "url": candidates[0]["url"],
                        "candidates": candidates,
                        "title": ad.get("title")
                        or (
                            legacy_title.get("tx")
                            if isinstance(legacy_title, dict)
                            else None
                        ),
                        "copyright": ad.get("copyright")
                        or (
                            legacy_copyright.get("tx")
                            if isinstance(legacy_copyright, dict)
                            else None
                        ),
                        "description": ad.get("description"),
                    }
                )

        return result

    def download_image(self, item):
        candidates = item.get("candidates") or [make_candidate(item["url"])]
        candidates = [candidate for candidate in candidates if candidate]
        if not candidates:
            raise RuntimeError("image has no usable download URL")

        for candidate in candidates:
            old_file = self.history.get(candidate["url"])
            if old_file is not None and old_file.is_file():
                print("Skip:", old_file.name)
                return None

        url = candidates[0]["url"]
        sha = hashlib.sha256(url.encode("utf-8")).hexdigest()

        print("Download:", item.get("title") or url)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_{sha[:8]}.jpg"
        image_file = self.output / filename
        temp_file = image_file.with_suffix(".jpg.part")

        failures = []
        for candidate in candidates:
            candidate_url = candidate["url"]
            try:
                with self.session.get(
                    candidate_url, timeout=(20, 90), stream=True
                ) as response:
                    response.raise_for_status()
                    with temp_file.open("wb") as output_file:
                        for chunk in response.iter_content(chunk_size=128 * 1024):
                            if chunk:
                                output_file.write(chunk)

                if temp_file.stat().st_size == 0:
                    raise RuntimeError("server returned an empty image")
                with Image.open(temp_file) as downloaded_image:
                    width, height = downloaded_image.size
                    downloaded_image.verify()
                url = candidate_url
                temp_file.replace(image_file)
                break
            except (
                OSError,
                requests.RequestException,
                RuntimeError,
                UnidentifiedImageError,
            ) as exc:
                temp_file.unlink(missing_ok=True)
                failures.append(f"{candidate_url}: {exc}")
        else:
            raise RuntimeError("all resolution candidates failed: " + "; ".join(failures))

        resolution = f"{width}x{height}"
        suffix = " (4K)" if (width, height) == PREFERRED_RESOLUTION else ""
        print(f"Resolution: {resolution}{suffix}")

        metadata = {
            **item,
            "url": url,
            "width": width,
            "height": height,
            "resolution": resolution,
            "is_4k": (
                width >= PREFERRED_RESOLUTION[0]
                and height >= PREFERRED_RESOLUTION[1]
            ),
            "download_time": datetime.now().isoformat(),
            "file": filename,
        }
        metadata_file = self.output / f"{filename}.json"
        metadata_file.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        self.add_to_history(metadata, image_file)
        return image_file

    def run(self):
        using_lower_resolution = False
        try:
            images = self.get_images()
            if not images:
                raise RuntimeError("4K API returned no usable images")
        except (requests.RequestException, RuntimeError) as exc:
            print(f"4K API failed, using lower-resolution API: {exc}", file=sys.stderr)
            images = self.get_lower_resolution_images()
            using_lower_resolution = True
        if not images:
            raise RuntimeError("Spotlight APIs returned no usable images")
        print(f"Found {len(images)} images")

        downloaded_files = []
        failures = []
        fallback_images = iter(()) if using_lower_resolution else None
        for image in images:
            try:
                image_file = self.download_image(image)
                if image_file is not None:
                    downloaded_files.append(image_file)
            except (OSError, requests.RequestException, RuntimeError) as exc:
                title = image.get("title") or image["url"]
                print(f"Failed: {title}: {exc}", file=sys.stderr)

                if fallback_images is None:
                    try:
                        fallback_images = iter(self.get_lower_resolution_images())
                    except (requests.RequestException, RuntimeError) as fallback_exc:
                        print(
                            f"Lower-resolution API failed: {fallback_exc}",
                            file=sys.stderr,
                        )
                        fallback_images = iter(())

                replaced = False
                for fallback_image in fallback_images:
                    try:
                        image_file = self.download_image(fallback_image)
                        if image_file is not None:
                            downloaded_files.append(image_file)
                        replaced = True
                        break
                    except (
                        OSError,
                        requests.RequestException,
                        RuntimeError,
                    ) as fallback_exc:
                        fallback_title = (
                            fallback_image.get("title") or fallback_image["url"]
                        )
                        print(
                            f"Failed fallback: {fallback_title}: {fallback_exc}",
                            file=sys.stderr,
                        )

                if not replaced:
                    failures.append((title, exc))

        if failures:
            raise RuntimeError(
                f"{len(failures)} of {len(images)} image(s) could not be downloaded"
            )
        return downloaded_files


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Download Microsoft Windows Spotlight wallpapers"
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    parser.add_argument(
        "--output",
        default="~/Pictures/SpotlightArchive",
        help="output directory",
    )
    parser.add_argument(
        "--count",
        type=positive_int,
        default=10,
        help="number of wallpapers",
    )
    parser.add_argument("--country", default="CN")
    parser.add_argument("--locale", default="zh-CN")
    wallpaper_actions = parser.add_mutually_exclusive_group()
    wallpaper_actions.add_argument(
        "--set-wallpaper",
        nargs="?",
        const="",
        metavar="IMAGE",
        help=(
            "set the GNOME light and dark wallpaper; if IMAGE is omitted, "
            "choose a random image from the output directory"
        ),
    )
    wallpaper_actions.add_argument(
        "--refresh",
        action="store_true",
        help=(
            "download only new wallpapers and set one when new images are found"
        ),
    )
    args = parser.parse_args(argv)

    if args.set_wallpaper not in (None, ""):
        try:
            set_gnome_wallpaper(args.set_wallpaper)
        except (OSError, RuntimeError) as exc:
            parser.exit(1, f"Error: {exc}\n")
        return

    app = SpotlightDownloader(
        os.path.expanduser(args.output),
        args.country,
        args.locale,
        args.count,
    )
    try:
        if args.refresh:
            refresh_wallpaper(app)
        else:
            app.run()
        if args.set_wallpaper == "":
            wallpaper = choose_wallpaper(app.output)
            set_gnome_wallpaper(wallpaper)
    except (OSError, requests.RequestException, RuntimeError) as exc:
        parser.exit(1, f"Error: {exc}\n")
    finally:
        app.session.close()


if __name__ == "__main__":
    main()
