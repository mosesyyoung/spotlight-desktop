#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path

import requests


API_URL = (
    "https://fd.api.iris.microsoft.com/v4/api/selection"
)


DEFAULT_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
}


class SpotlightDownloader:

    def __init__(
        self,
        output,
        country="CN",
        locale="zh-CN",
        count=10,
    ):
        self.output = Path(output)
        self.country = country
        self.locale = locale
        self.count = count

        self.output.mkdir(
            parents=True,
            exist_ok=True
        )

        self.db_file = self.output / "downloaded.json"

        if self.db_file.exists():
            self.db = json.loads(
                self.db_file.read_text(
                    encoding="utf-8"
                )
            )
        else:
            self.db = {}


    def save_db(self):
        self.db_file.write_text(
            json.dumps(
                self.db,
                ensure_ascii=False,
                indent=2
            ),
            encoding="utf-8"
        )


    def get_images(self):

        params = {
            "placement": "88000820",
            "bcnt": self.count,
            "country": self.country,
            "locale": self.locale,
            "fmt": "json",
        }

        print("Query Spotlight API...")

        r = requests.get(
            API_URL,
            params=params,
            headers=DEFAULT_HEADERS,
            timeout=20,
        )

        r.raise_for_status()

        data = r.json()

        result = []

        items = data["batchrsp"]["items"]

        for item in items:

            obj = json.loads(
                item["item"]
            )

            ad = obj.get("ad", {})

            image = (
                ad
                .get("landscapeImage", {})
                .get("asset")
            )

            if not image:
                continue

            result.append({
                "url": image,
                "title": ad.get("title"),
                "copyright": ad.get("copyright"),
                "description": ad.get("description"),
            })

        return result



    def download_image(self, item):

        url = item["url"]

        sha = hashlib.sha256(
            url.encode()
        ).hexdigest()


        if sha in self.db:
            print(
                "Skip:",
                self.db[sha]["file"]
            )
            return


        print(
            "Download:",
            item["title"]
        )


        r = requests.get(
            url,
            headers=DEFAULT_HEADERS,
            timeout=60
        )

        r.raise_for_status()


        timestamp = datetime.now().strftime(
            "%Y%m%d_%H%M%S"
        )

        filename = (
            f"{timestamp}_{sha[:8]}.jpg"
        )


        img_file = (
            self.output /
            filename
        )


        img_file.write_bytes(
            r.content
        )


        meta_file = (
            self.output /
            f"{filename}.json"
        )


        metadata = {
            **item,
            "download_time":
                datetime.now()
                .isoformat(),
            "file":
                filename
        }


        meta_file.write_text(
            json.dumps(
                metadata,
                ensure_ascii=False,
                indent=2
            ),
            encoding="utf-8"
        )


        self.db[sha] = metadata

        self.save_db()



    def run(self):

        images = self.get_images()

        print(
            f"Found {len(images)} images"
        )

        for img in images:
            self.download_image(img)



def main():

    parser = argparse.ArgumentParser(
        description=
        "Download Microsoft Windows Spotlight wallpapers"
    )

    parser.add_argument(
        "--output",
        default=
        "~/Pictures/SpotlightArchive",
        help="output directory"
    )

    parser.add_argument(
        "--count",
        type=int,
        default=10,
        help="number of wallpapers"
    )

    parser.add_argument(
        "--country",
        default="CN"
    )

    parser.add_argument(
        "--locale",
        default="zh-CN"
    )


    args = parser.parse_args()


    output = os.path.expanduser(
        args.output
    )


    app = SpotlightDownloader(
        output,
        args.country,
        args.locale,
        args.count,
    )

    app.run()



if __name__ == "__main__":
    main()
