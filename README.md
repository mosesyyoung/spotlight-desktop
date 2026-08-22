# Spotlight Downloader

A modern Python implementation of Microsoft Windows Spotlight wallpaper downloader.

Download beautiful Windows Spotlight wallpapers on Linux/macOS without requiring Windows, .NET, or Mono.

> Inspired by [ORelio/Spotlight-Downloader](https://github.com/ORelio/Spotlight-Downloader)

---

## Features

Current MVP:

- ✅ Query Microsoft Windows Spotlight API
- ✅ Download Spotlight wallpapers
- ✅ Prefer 3840×2160 (4K), with lower-resolution fallback
- ✅ Detect and record the downloaded image resolution
- ✅ Support localization (country / locale)
- ✅ Download metadata
- ✅ Duplicate detection
- ✅ Native Python implementation
- ✅ No Mono / .NET dependency

Example:

```text
Query Spotlight API...
Found 4 images
Download: 瞧瞧这张大嘴
Download: 寂静的神圣建筑
Download: 玫瑰色巨石
Download: 河湾周边的景观
```

---

## Motivation

The original Windows Spotlight downloader ecosystem is mainly based on Windows/.NET.

The famous project:

- ORelio/Spotlight-Downloader

works very well on Windows, but Linux users need Mono compatibility.

On modern Linux distributions:

- Ubuntu 26.04

- Mono 6.x

- New Microsoft TLS certificate chain

may cause HTTPS certificate validation problems:

```text
System.Net.WebException:  

TrustFailure  
(Authentication failed)
```

This project uses Python and the system OpenSSL stack instead:

```text
Python  
|  
requests  
|  
OpenSSL  
|  
Microsoft Spotlight API
```

No Mono required.

---

## Requirements

Supported:

- Ubuntu 22.04+

- Ubuntu 24.04

- Ubuntu 26.04

- Other Linux distributions with Python 3

Required software:

- Python >= 3.10

- python3-venv

- pip

---

## Installation

### 1. Install Python environment

Ubuntu:

```bash
sudo apt update

sudo apt install \
    python3 \
    python3-venv
```

Check:

```bash
python3 --version
```

---

### 2. Clone project

```bash
git clone https://github.com/<your-name>/spotlight-downloader.git

cd spotlight-downloader
```

---

### 3. Create virtual environment

Recommended:

```bash
python3 -m venv .venv
```

Activate:

```bash
source .venv/bin/activate
```

Your shell should become:

```
(.venv) user@host:~/spotlight-downloader$
```

---

### 4. Install dependencies

```bash
pip install -r requirements.txt
```

Current dependencies:

```
requests
```

---

## Usage

Default:

```bash
python spotlight_downloader.py
```

Default output:

```
~/Pictures/SpotlightArchive
```

Example:

```
SpotlightArchive/

├── 20260822_015300_xxxxxxxx.jpg

├── 20260822_015300_xxxxxxxx.jpg.json

└── downloaded.json
```

---

## Options

Example:

```bash
python spotlight_downloader.py \
    --count 20 \
    --country CN \
    --locale zh-CN
```

Parameters:

| Option    | Description          | Default                     |
| --------- | -------------------- | --------------------------- |
| --output  | Output directory     | ~/Pictures/SpotlightArchive |
| --count   | Number of wallpapers | 10                          |
| --country | Country code         | CN                          |
| --locale  | Language locale      | zh-CN                       |

The Spotlight API returns at most four images per request. Larger `--count`
values are fetched automatically in multiple batches and deduplicated by URL.

---

## Metadata

The downloader first uses the v4 Spotlight feed for 3840×2160 images. If that
feed or a 4K asset is unavailable, it falls back to the v3 feed's lower-resolution
wallpapers. Legacy placeholder assets are ignored.

Each image's JSON metadata includes its detected `width`, `height`, `resolution`,
and `is_4k` values. These dimensions are read from the downloaded image itself,
not trusted from the filename or API response.

For every downloaded image:

Example:

```json
{
  "url": "https://res.public.onecdn.static.microsoft/...",
  "title": "玫瑰色巨石",
  "copyright": "© Microsoft",
  "description": "...",
  "width": 3840,
  "height": 2160,
  "resolution": "3840x2160",
  "is_4k": true,
  "download_time": "2026-08-22T01:30:00",
  "file": "20260822_013000_xxxxxxxx.jpg"
}
```

---

## Project Roadmap

### v1.0 MVP

Completed:

- [x] Microsoft Spotlight API integration
- [x] Wallpaper download
- [x] Metadata export
- [x] Duplicate detection

---

### v1.1 Desktop Integration

Planned:

#### Resolution handling

- [x] Detect original image resolution
- [x] Prefer 3840x2160 / 4K images
- [x] Fallback to lower resolution

#### Portrait mode

Support:

- Landscape wallpaper
- Portrait wallpaper

#### EXIF metadata

Write:

- Title
- Copyright
- Description
- Location

Example:

```
image.jpg

EXIF:
    Title: Lake Tahoe
    Copyright: NASA
```

#### GNOME integration

Automatically set wallpaper:

Example:

```bash
gsettings set \
org.gnome.desktop.background \
picture-uri \
file:///path/to/image.jpg
```

---

### v1.2 Automation

#### systemd timer

Automatic daily download.

Example:

Every day:

```
06:00
```

Download new Spotlight wallpapers automatically.

Architecture:

```
systemd timer
       |
       v
spotlight-downloader
       |
       v
~/Pictures/SpotlightArchive
```

---

### v1.3 Service Platform

Future:

#### Web UI

A lightweight photo management interface.

Features:

- Browse wallpapers
- Search metadata
- Preview images
- Set wallpaper

Similar experience:

- Synology Photo Station
- Immich

---

#### SQLite database

Replace JSON database.

Store:

```
images
├── id
├── url
├── sha256
├── title
├── copyright
├── downloaded_time
└── path
```

Benefits:

- Faster search
- Better metadata management
- Duplicate detection

---

#### Docker support

Containerized deployment:

```
Docker
 |
 spotlight-downloader
 |
 volume

 ~/Pictures/SpotlightArchive
```

Possible usage:

```bash
docker run \
-v ~/Pictures:/data \
spotlight-downloader
```

---

## Development

Run:

```bash
source .venv/bin/activate

python spotlight_downloader.py
```

Format:

Future:

- ruff
- black
- pytest

---

## License

MIT License

---

## Acknowledgements

Thanks to:

- Microsoft Windows Spotlight API
- ORelio/Spotlight-Downloader
