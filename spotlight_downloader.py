#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


API_URL = "https://fd.api.iris.microsoft.com/v4/api/selection"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}


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
        self.db_file = self.output / "downloaded.json"
        self.db = self.load_db()

    def load_db(self):
        if not self.db_file.exists():
            return {}

        try:
            data = json.loads(self.db_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Warning: ignoring invalid {self.db_file}: {exc}", file=sys.stderr)
            return {}

        if not isinstance(data, dict):
            print(f"Warning: ignoring invalid {self.db_file}: expected an object", file=sys.stderr)
            return {}
        return data

    def save_db(self):
        temp_file = self.db_file.with_suffix(".json.tmp")
        temp_file.write_text(
            json.dumps(self.db, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temp_file.replace(self.db_file)

    def get_images(self):
        params = {
            "placement": "88000820",
            "bcnt": self.count,
            "country": self.country,
            "locale": self.locale,
            "fmt": "json",
        }

        print("Query Spotlight API...")
        response = self.session.get(API_URL, params=params, timeout=(20, 30))
        response.raise_for_status()

        try:
            items = response.json()["batchrsp"]["items"]
        except (requests.exceptions.JSONDecodeError, KeyError, TypeError) as exc:
            raise RuntimeError("Spotlight API returned an unexpected response") from exc

        result = []
        for item in items:
            try:
                raw_item = item["item"]
                obj = json.loads(raw_item) if isinstance(raw_item, str) else raw_item
                ad = obj.get("ad", {})
                image = ad.get("landscapeImage", {}).get("asset")
            except (KeyError, TypeError, json.JSONDecodeError):
                continue

            if image:
                result.append(
                    {
                        "url": image,
                        "title": ad.get("title"),
                        "copyright": ad.get("copyright"),
                        "description": ad.get("description"),
                    }
                )

        return result

    def download_image(self, item):
        url = item["url"]
        sha = hashlib.sha256(url.encode("utf-8")).hexdigest()

        old_record = self.db.get(sha)
        if isinstance(old_record, dict) and old_record.get("file"):
            old_file = self.output / old_record["file"]
            if old_file.is_file():
                print("Skip:", old_record["file"])
                return

        print("Download:", item.get("title") or url)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_{sha[:8]}.jpg"
        image_file = self.output / filename
        temp_file = image_file.with_suffix(".jpg.part")

        try:
            with self.session.get(url, timeout=(20, 90), stream=True) as response:
                response.raise_for_status()
                with temp_file.open("wb") as output_file:
                    for chunk in response.iter_content(chunk_size=128 * 1024):
                        if chunk:
                            output_file.write(chunk)

            if temp_file.stat().st_size == 0:
                raise RuntimeError("server returned an empty image")
            temp_file.replace(image_file)
        except Exception:
            temp_file.unlink(missing_ok=True)
            raise

        metadata = {
            **item,
            "download_time": datetime.now().isoformat(),
            "file": filename,
        }
        metadata_file = self.output / f"{filename}.json"
        metadata_file.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        self.db[sha] = metadata
        self.save_db()

    def run(self):
        images = self.get_images()
        print(f"Found {len(images)} images")

        failures = []
        for image in images:
            try:
                self.download_image(image)
            except (OSError, requests.RequestException, RuntimeError) as exc:
                title = image.get("title") or image["url"]
                failures.append((title, exc))
                print(f"Failed: {title}: {exc}", file=sys.stderr)

        if failures:
            raise RuntimeError(
                f"{len(failures)} of {len(images)} image(s) could not be downloaded"
            )


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def main():
    parser = argparse.ArgumentParser(
        description="Download Microsoft Windows Spotlight wallpapers"
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
    args = parser.parse_args()

    app = SpotlightDownloader(
        os.path.expanduser(args.output),
        args.country,
        args.locale,
        args.count,
    )
    try:
        app.run()
    except (OSError, requests.RequestException, RuntimeError) as exc:
        parser.exit(1, f"Error: {exc}\n")
    finally:
        app.session.close()


if __name__ == "__main__":
    main()
