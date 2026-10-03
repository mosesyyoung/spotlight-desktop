# Spotlight Desktop

A lightweight Microsoft Windows Spotlight experience for Ubuntu/Linux
desktops.

Spotlight Desktop is a self-contained GNOME Shell extension that downloads
high-resolution Microsoft Spotlight images, deduplicates them using per-image
metadata, applies new wallpapers, and exposes information about the current
image in the GNOME panel. It does not require a Python environment or systemd
service for normal desktop use.

```text
Microsoft Spotlight
        ↓
4K wallpaper
        ↓
metadata-based deduplication
        ↓
GNOME wallpaper
        ↓
extension-managed automatic refresh
        ↓
GNOME Spotlight information
```

> Inspired by [ORelio/Spotlight-Downloader](https://github.com/ORelio/Spotlight-Downloader)

## Features

- Microsoft Spotlight API integration with localization
- 3840×2160 / 4K preference and lower-resolution fallback
- Per-image JSON metadata and metadata-based download history
- GNOME light and dark wallpaper integration
- Refresh when the extension is enabled and every hour while it is running
- XDG-compatible `current.json` state for the active wallpaper
- GNOME Shell Panel Indicator with a metadata popup
- Automatic popup refresh through `Gio.FileMonitor`

The primary desktop target is Ubuntu 26.04 with GNOME Shell 50 on Wayland. The
GNOME extension uses only platform libraries provided by GNOME. The optional
Python CLI continues to support downloading on other Linux desktops. No Conky
or systemd service is required by the extension.

## Extension requirements

- GNOME Shell 50 for the included extension
- An active GNOME session and network connection

Python 3.10, `pip`, Pillow, and Requests are required only for the optional
command-line client.

## Extension installation

```bash
git clone https://github.com/mosesyyoung/spotlight-desktop.git
cd spotlight-desktop
./scripts/install-gnome-extension.sh
gnome-extensions enable spotlight-desktop@mosesyyoung
```

Enabling the extension immediately checks for new Spotlight images. While the
extension remains enabled, it checks again every hour. Downloads are stored in
`~/Pictures/SpotlightArchive`; new images are applied to both the light and dark
GNOME background settings.

If GNOME Shell has not discovered a newly installed extension, log out and log
back in before running the enable command. The installer writes only to the
current user's data directory and does not require root.

## Optional command-line client

The original Python implementation remains available for scripting and
non-GNOME environments. Install its dependencies with:

```bash
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

## Legacy systemd refresh

The systemd user timer is retained for CLI users and headless scheduling. It is
not needed when automatic refresh is provided by the GNOME extension. Do not
enable both schedulers unless duplicate API checks are acceptable.

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

## GNOME Spotlight extension

The extension targets Ubuntu 26.04, GNOME Shell 50, and Wayland. It adds a
lightweight information icon to the right side of the top panel, performs
downloads asynchronously with libsoup, manages its own hourly refresh, and
uses `Gio.Settings` to apply the wallpaper without spawning external commands.
The popup shows download status and the metadata present in `current.json`.

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

1. Install and enable the extension; confirm the panel indicator appears and
   reports that it is checking for wallpapers.
2. Confirm a wallpaper and adjacent metadata JSON appear in
   `~/Pictures/SpotlightArchive`.
3. Confirm both light and dark GNOME backgrounds change and inspect
   `~/.local/state/spotlight-desktop/current.json`.
4. Open the popup and compare its text with `current.json`.
5. Replace `current.json` with another valid state file and confirm the open
   popup refreshes.
6. Disable the extension and confirm the indicator disappears:

   ```bash
   gnome-extensions disable spotlight-desktop@mosesyyoung
   ```

7. Enable it again and confirm only one indicator and one refresh operation
   appear.

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
│       ├── spotlight.js
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

### v1.4 Self-contained GNOME Extension

- [x] Document the extension-first architecture
- [x] Download Spotlight images directly with GJS and libsoup
- [x] Preserve metadata-based download history
- [x] Apply light and dark wallpapers with `Gio.Settings`
- [x] Refresh on enable and hourly without systemd
- [ ] Add extension preferences for locale and refresh behavior

## Development and testing

Run the automated checks:

```bash
source .venv/bin/activate
python -m unittest discover -s tests -v
python -m py_compile spotlight_downloader.py
node --check gnome-extension/spotlight-desktop@mosesyyoung/extension.js
node --check gnome-extension/spotlight-desktop@mosesyyoung/spotlight.js
sh -n scripts/install-gnome-extension.sh
gnome-extensions pack --force \
    --extra-source=spotlight.js \
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
