# Spotlight Desktop

A modern Python implementation of Microsoft Windows Spotlight experience for Linux desktops.

Download, manage, and automatically apply beautiful Spotlight wallpapers without requiring Windows, .NET, or Mono.

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
- ✅ GNOME light and dark wallpaper integration

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

GNOME wallpaper integration additionally requires:

- An active GNOME desktop session

- `gsettings` (provided by `libglib2.0-bin` on Ubuntu)

- Access to the session's D-Bus/dconf services; wallpaper changes will not work
  from a plain SSH session or a timer that is not connected to the desktop
  session

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
git clone https://github.com/mosesyyoung/spotlight-desktop.git

cd spotlight-desktop
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
(.venv) user@host:~/spotlight-desktop$
```

---

### 4. Install dependencies

```bash
pip install -r requirements.txt
```

Current dependencies:

```
requests>=2.31.0
urllib3>=1.26.0
Pillow>=10.0.0
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

└── 20260822_015300_xxxxxxxx.jpg.json
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

| Option                  | Description          | Default                     |
| ----------------------- | -------------------- | --------------------------- |
| --output                | Output directory     | ~/Pictures/SpotlightArchive |
| --count                 | Number of wallpapers | 10                          |
| --country               | Country code         | CN                          |
| --locale                | Language locale      | zh-CN                       |
| --set-wallpaper [IMAGE] | Set GNOME wallpaper  | Disabled                    |
| --refresh               | Set a new download    | Disabled                    |
| --version               | Show program version | —                           |

The Spotlight API returns at most four images per request. Larger `--count`
values are fetched automatically in multiple batches and deduplicated by URL.

To download wallpapers and set a random image from the output directory for
both GNOME's light and dark appearances:

```bash
python spotlight_downloader.py --set-wallpaper
```

To use a specific image instead:

```bash
python spotlight_downloader.py --set-wallpaper ~/Pictures/wallpaper.jpg
```

When `IMAGE` is provided, the wallpaper is changed immediately without
contacting the Spotlight API or downloading new images.

Wallpaper integration uses GNOME's `picture-uri` and `picture-uri-dark`
settings. It requires `gsettings` and an active GNOME desktop session so the
command can reach the user's D-Bus/dconf settings database.

To check for new images once and change the wallpaper only when a new image was
downloaded:

```bash
python spotlight_downloader.py --refresh
```

Known images are identified through their existing metadata files and are not
downloaded again. If every image returned by Spotlight is already in the
archive, `--refresh` leaves the current wallpaper unchanged.

---

## Scheduled refresh

The included user-level systemd timer runs the refresh command hourly. Install
the application and units into the paths expected by the service:

```bash
install -Dm755 spotlight_downloader.py \
    ~/.local/share/spotlight-desktop/spotlight_downloader.py
install -Dm644 requirements.txt \
    ~/.local/share/spotlight-desktop/requirements.txt

python3 -m venv ~/.local/share/spotlight-desktop/.venv
~/.local/share/spotlight-desktop/.venv/bin/pip install \
    -r ~/.local/share/spotlight-desktop/requirements.txt

install -Dm644 systemd/spotlight-desktop.service \
    ~/.config/systemd/user/spotlight-desktop.service
install -Dm644 systemd/spotlight-desktop.timer \
    ~/.config/systemd/user/spotlight-desktop.timer

systemctl --user daemon-reload
systemctl --user enable --now spotlight-desktop.timer
```

The service uses the default `~/Pictures/SpotlightArchive` directory. It runs
inside the logged-in user's systemd manager so `gsettings` can access the GNOME
session. Check the schedule and recent logs with:

```bash
systemctl --user list-timers spotlight-desktop.timer
journalctl --user -u spotlight-desktop.service
```

Run an immediate refresh with:

```bash
systemctl --user start spotlight-desktop.service
```

---

## Metadata

The downloader first uses the v4 Spotlight feed for 3840×2160 images. If that
feed or a 4K asset is unavailable, it falls back to the v3 feed's lower-resolution
wallpapers. Legacy placeholder assets are ignored.

Each image's JSON metadata includes its detected `width`, `height`, `resolution`,
and `is_4k` values. These dimensions are read from the downloaded image itself,
not trusted from the filename or API response.

The per-image JSON files also serve as download history. At startup, the
downloader scans existing metadata and skips known asset URLs when the matching
image is still present. Invalid metadata is ignored with a warning.

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

Completed:

#### Resolution handling

- [x] Detect original image resolution
- [x] Prefer 3840x2160 / 4K images
- [x] Fallback to lower resolution

#### Download management

- [x] Remove `downloaded.json`
- [x] Use image metadata JSON files as download history
- [x] Scan existing metadata before downloading
- [x] Avoid duplicate downloads

#### GNOME integration

- [x] Automatically set the GNOME wallpaper
- [x] Support light and dark wallpaper settings
- [x] Provide a `--set-wallpaper [IMAGE]` CLI option

When `IMAGE` is provided, use that image. When the option is used without an
image, choose a random image from the output directory.

Example:

```bash
gsettings set org.gnome.desktop.background picture-uri \
    file:///path/to/image.jpg
gsettings set org.gnome.desktop.background picture-uri-dark \
    file:///path/to/image.jpg
```

---

### v1.2 Automation

Completed:

#### Scheduled wallpaper refresh

- [x] systemd timer support
- [x] Hourly update check
- [x] Download only new wallpapers
- [x] Automatically set a newly downloaded wallpaper

If new wallpapers are available, download them and set one as the wallpaper.
If no new wallpaper is available, make no changes.

## Future ideas

- Desktop information overlay
- GNOME Extension integration

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
