# Spotlight Desktop

A lightweight Microsoft Windows Spotlight experience for Ubuntu/Linux
desktops.

Spotlight Desktop downloads high-resolution Microsoft Spotlight images,
deduplicates them using per-image metadata, applies new wallpapers through
GNOME, and exposes information about the current image in the GNOME panel.

```text
Microsoft Spotlight
        ↓
4K wallpaper
        ↓
metadata-based deduplication
        ↓
GNOME wallpaper
        ↓
hourly automatic refresh
        ↓
GNOME Spotlight information
```

> Inspired by [ORelio/Spotlight-Downloader](https://github.com/ORelio/Spotlight-Downloader)

## Features

- Microsoft Spotlight API integration with localization
- 3840×2160 / 4K preference and lower-resolution fallback
- Per-image JSON metadata and metadata-based download history
- GNOME light and dark wallpaper integration
- Hourly refresh through a systemd user timer
- XDG-compatible `current.json` state for the active wallpaper
- GNOME Shell Panel Indicator with a metadata popup
- Automatic popup refresh through `Gio.FileMonitor`

The primary desktop target is Ubuntu 26.04 with GNOME Shell 50 on Wayland.
Downloading also works on other Linux desktops with Python, while wallpaper and
panel integration require GNOME. No Conky service is used.

## Requirements

- Python 3.10 or newer
- `python3-venv` and `pip`
- An active GNOME session for wallpaper integration
- `gsettings` (provided by `libglib2.0-bin` on Ubuntu)
- GNOME Shell 50 for the included extension

Install the base Ubuntu packages:

```bash
sudo apt update
sudo apt install python3 python3-venv libglib2.0-bin
```

## Installation

```bash
git clone https://github.com/mosesyyoung/spotlight-desktop.git
cd spotlight-desktop

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Runtime Python dependencies are listed in `requirements.txt`:

```text
requests>=2.31.0
urllib3>=1.26.0
Pillow>=10.0.0
```

## Command-line usage

Download Spotlight wallpapers to the default archive:

```bash
python spotlight_downloader.py
```

The default archive is `~/Pictures/SpotlightArchive`. Each image is stored next
to its metadata:

```text
SpotlightArchive/
├── 20260823_200000_12345678.jpg
└── 20260823_200000_12345678.jpg.json
```

Available options:

| Option                  | Description                                      | Default                     |
| ----------------------- | ------------------------------------------------ | --------------------------- |
| `--output DIRECTORY`    | Wallpaper archive                                | `~/Pictures/SpotlightArchive` |
| `--count NUMBER`        | Number of Spotlight results                      | `10`                        |
| `--country CODE`        | Spotlight country code                           | `CN`                        |
| `--locale LOCALE`       | Spotlight language locale                        | `zh-CN`                     |
| `--set-wallpaper [IMAGE]` | Set a specific image or a random archive image | Disabled                    |
| `--refresh`             | Apply a wallpaper only when new images download  | Disabled                    |
| `--version`             | Print the installed version                      | —                           |

Examples:

```bash
# Download 20 localized images
python spotlight_downloader.py --count 20 --country CN --locale zh-CN

# Download, then select a random image from the archive
python spotlight_downloader.py --set-wallpaper

# Set a local image without contacting the Spotlight API
python spotlight_downloader.py --set-wallpaper ~/Pictures/wallpaper.jpg

# Check once and change the wallpaper only if a new image is downloaded
python spotlight_downloader.py --refresh
```

`--set-wallpaper` and `--refresh` set both GNOME `picture-uri` and
`picture-uri-dark`. Run them from an active desktop session so `gsettings` can
reach the user's D-Bus/dconf services.

## Metadata and download history

Spotlight Desktop does not use SQLite or a shared download-history database.
Every downloaded image has one adjacent metadata JSON file, and those files are
scanned at startup to avoid downloading known URLs.

The existing metadata format is preserved:

```json
{
  "url": "https://res.public.onecdn.static.microsoft/...",
  "candidates": [
    {
      "url": "https://res.public.onecdn.static.microsoft/..._3840x2160.jpg",
      "width": 3840,
      "height": 2160
    }
  ],
  "title": "Example title",
  "copyright": "© Photographer / Getty Images",
  "description": "Example description",
  "width": 3840,
  "height": 2160,
  "resolution": "3840x2160",
  "is_4k": true,
  "download_time": "2026-08-23T20:00:00",
  "file": "20260823_200000_12345678.jpg"
}
```

Fields supplied by Microsoft may be absent. Image dimensions are read from the
downloaded image rather than trusted from an API filename.

## Current wallpaper state

After GNOME confirms that both wallpaper settings were applied, Spotlight
Desktop atomically writes its state file.

When `XDG_STATE_HOME` is set, the path is
`$XDG_STATE_HOME/spotlight-desktop/current.json`. Otherwise it is
`~/.local/state/spotlight-desktop/current.json`.

This is a small interface describing the current wallpaper, not a download
database. A typical file is:

```json
{
  "image": "/home/user/Pictures/SpotlightArchive/example.jpg",
  "metadata": "/home/user/Pictures/SpotlightArchive/example.jpg.json",
  "title": "Example title",
  "description": "Example description",
  "copyright": "© Photographer / Getty Images",
  "url": "https://res.public.onecdn.static.microsoft/...",
  "updated_at": "2026-08-23T20:00:00+08:00"
}
```

`image` and `updated_at` are always present. `metadata`, `title`, `description`,
`copyright`, `location`, and `url` are included only when valid values exist.
Spotlight Desktop does not infer a location from titles or descriptions.

The file is written as UTF-8 through a temporary file followed by an atomic
rename. A failed GNOME wallpaper update leaves the previous `current.json`
untouched.

## Hourly systemd refresh

The included systemd user timer checks for new Spotlight images every hour. If
new files are downloaded, one of those files is applied and `current.json` is
updated. If all returned images already exist, neither the wallpaper nor
`current.json` changes.

Install the backend and timer into the paths used by the supplied service:

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

Inspect or manually trigger the service:

```bash
systemctl --user list-timers spotlight-desktop.timer
systemctl --user start spotlight-desktop.service
journalctl --user -u spotlight-desktop.service
```

## GNOME Spotlight Information extension

The extension targets Ubuntu 26.04, GNOME Shell 50, and Wayland. It adds a
lightweight information icon to the right side of the top panel. The popup
shows only fields present in `current.json`, wraps long descriptions, supports
UTF-8 text, and displays a fallback message before Spotlight Desktop has set a
wallpaper.

Install the extension for the current user:

```bash
./scripts/install-gnome-extension.sh
gnome-extensions enable spotlight-desktop@mosesyyoung
```

If GNOME Shell has not discovered a newly installed extension, log out and log
back in before running the enable command. The installer never writes to
`/usr/share` and does not require root.

Inspect its state:

```bash
gnome-extensions list
gnome-extensions info spotlight-desktop@mosesyyoung
journalctl --user -f -o cat /usr/bin/gnome-shell
```

The extension monitors the XDG state directory with `Gio.FileMonitor`. Updating
`current.json` refreshes the popup immediately, including while it is open; no
polling, Shell restart, or manual metadata refresh is required. Missing state
shows an unavailable message. Invalid JSON is logged without crashing GNOME
Shell, and the last successfully loaded information remains visible.

### Extension test checklist

1. Run `python spotlight_downloader.py --set-wallpaper IMAGE` for an archived
   Spotlight image and inspect `~/.local/state/spotlight-desktop/current.json`.
2. Install and enable the extension; confirm the panel indicator appears.
3. Open the popup and compare its text with `current.json`.
4. Replace `current.json` with another valid state file and confirm the open
   popup refreshes.
5. Disable the extension and confirm the indicator disappears:

   ```bash
   gnome-extensions disable spotlight-desktop@mosesyyoung
   ```

6. Enable it again and confirm only one indicator appears.

For isolated Wayland testing on GNOME 49 or newer, GNOME documents a nested
development session using `mutter-devkit` (`mutter-dev-bin` on Ubuntu):

```bash
dbus-run-session gnome-shell --devkit --wayland
```

## Repository layout

```text
spotlight-desktop/
├── spotlight_downloader.py
├── requirements.txt
├── systemd/
│   ├── spotlight-desktop.service
│   └── spotlight-desktop.timer
├── gnome-extension/
│   └── spotlight-desktop@mosesyyoung/
│       ├── metadata.json
│       ├── extension.js
│       └── stylesheet.css
├── scripts/
│   └── install-gnome-extension.sh
└── tests/
    └── test_resolution.py
```

## Project Roadmap

### v1.0 MVP

- [x] Microsoft Spotlight API integration
- [x] Wallpaper download
- [x] Metadata export
- [x] Basic duplicate detection

### v1.1 Desktop Integration

- [x] Resolution detection
- [x] Prefer 3840×2160 / 4K wallpapers
- [x] Fallback to lower resolutions
- [x] Metadata-based duplicate detection
- [x] Remove standalone `downloaded.json`
- [x] GNOME wallpaper integration
- [x] GNOME light/dark wallpaper support

### v1.2 Automation

- [x] systemd user timer
- [x] Hourly Spotlight update checks
- [x] Download only new wallpapers
- [x] Automatically apply a new wallpaper

### v1.3 GNOME Spotlight Information

- [x] `current.json` desktop state interface
- [x] GNOME Shell Panel Indicator
- [x] Spotlight metadata popup
- [x] Automatic metadata refresh with `Gio.FileMonitor`

## Development and testing

Run the automated checks:

```bash
source .venv/bin/activate
python -m unittest discover -s tests -v
python -m py_compile spotlight_downloader.py
node --check \
    gnome-extension/spotlight-desktop@mosesyyoung/extension.js
sh -n scripts/install-gnome-extension.sh
gnome-extensions pack --force \
    gnome-extension/spotlight-desktop@mosesyyoung
systemd-analyze --user verify \
    systemd/spotlight-desktop.service \
    systemd/spotlight-desktop.timer
```

## License

MIT License. See [LICENSE](LICENSE).

## Acknowledgements

- Microsoft Spotlight
- [ORelio/Spotlight-Downloader](https://github.com/ORelio/Spotlight-Downloader)
- GNOME Shell and GJS
