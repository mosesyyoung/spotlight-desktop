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
- Refresh when the extension is enabled and at a configurable interval
- XDG-compatible `current.json` state for the active wallpaper
- GNOME Shell Panel Indicator with a metadata popup
- Automatic popup refresh through `Gio.FileMonitor`
- A native preferences window for download, schedule, locale, and wallpaper
  behavior settings
- A cached thumbnail of the active wallpaper in the panel popup
- Compact title-bar controls with hover hints for choosing an archive
  wallpaper, selecting a local image, or checking Spotlight immediately

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
the XDG Pictures directory under `SpotlightArchive`. By default, a newly
downloaded image is applied to both the light and dark GNOME backgrounds; the
wallpaper remains unchanged when no new image is available.

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
For a manually selected image, `metadata` refers to a valid adjacent
`<image-name>.json` file when one exists; the image does not need to be inside
the configured archive.

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
downloads asynchronously with libsoup, manages its own configurable refresh
schedule, and uses `Gio.Settings` to apply the wallpaper without spawning
external commands. The popup title places three compact icon controls to the
right of **Spotlight**. Hovering over an icon identifies its action. Below the
title, the popup shows download status, available metadata, a 16:9 thumbnail of
the active wallpaper, and its filename. Content scrolls only when it would
otherwise exceed the available desktop height.

Open the preferences window from Extension Manager or from the command line:

```bash
gnome-extensions prefs spotlight-desktop@mosesyyoung
```

Available settings:

| Setting | Default | Description |
| ------- | ------- | ----------- |
| Archive folder | `~/Pictures/SpotlightArchive` | Uses the localized XDG Pictures directory when unchanged |
| Check for new wallpapers | Every hour | From one minute through one day, or only when enabled; enabling always triggers one check |
| Results per check | `10` | Accepts values from 1 through 50 |
| Country code | `CN` | Two-letter Spotlight country code |
| Language and locale | `zh-CN` | Locale sent to the Spotlight APIs |
| After checking for wallpapers | Apply a newly downloaded wallpaper | Keep the current wallpaper when no new image was downloaded |

The wallpaper behavior choices match the optional Python CLI: **Apply a newly
downloaded wallpaper** matches `--refresh`, **Set a random wallpaper from the
archive** matches `--set-wallpaper` without an image argument, and **Download
only** performs no wallpaper action. Wallpaper changes update both
`picture-uri` and `picture-uri-dark`.

The popup actions are independent of the configured post-check behavior:

- **Random wallpaper** applies a random JPEG, PNG, or WebP image from the
  configured archive without using the network. When possible, it avoids the
  current image.
- **Choose a wallpaper** uses the desktop file chooser to apply a local JPEG,
  PNG, or WebP image. It requests the configured archive folder as the starting
  location, creating it when possible; it falls back to the XDG Pictures
  directory and then the home directory. The desktop portal may ignore this
  location hint. The selected file is not copied into the archive. If an
  adjacent `<image-name>.json` file contains valid Spotlight metadata, that
  information is shown in the popup.
- **Check for new wallpapers** performs the same operation as an automatic
  check, including the configured **After checking for wallpapers** action. It
  also restarts the configured interval so another scheduled check does not
  immediately follow it.

Only one popup action or refresh can run at a time. The controls are disabled
until the current operation finishes. Enabled controls use the current Shell
theme with full opacity and hover feedback; disabled controls become faint and
lose their background without assuming a light or dark theme. Cancelling the
file chooser leaves the wallpaper unchanged.

Inspect its state:

```bash
gnome-extensions list
gnome-extensions info spotlight-desktop@mosesyyoung
journalctl --user -f -o cat /usr/bin/gnome-shell
```

The extension monitors the XDG state directory with `Gio.FileMonitor`. Updating
`current.json` refreshes the popup immediately, including while it is open; no
polling, Shell restart, or manual metadata refresh is required. Missing state
shows an unavailable message. The current image is loaded asynchronously into
a cached 16:9 thumbnail between its descriptive text and filename. A missing
image skips the thumbnail, and an image-loading failure does not affect the
remaining information. Invalid JSON is logged without crashing GNOME Shell,
and the last successfully loaded information remains visible.

### Extension test checklist

1. Install and enable the extension; confirm the panel indicator appears and
   reports that it is checking for wallpapers.
2. Confirm an image and adjacent metadata JSON appear in the configured archive
   directory (the XDG Pictures directory under `SpotlightArchive` by default).
3. Confirm both light and dark GNOME backgrounds change and inspect
   `~/.local/state/spotlight-desktop/current.json`.
4. Open the popup, compare its text with `current.json`, and confirm the three
   icon controls appear to the right of **Spotlight**, each displays a hover
   hint, and the thumbnail appears between the descriptive text and filename.
5. Click **Random wallpaper** and confirm a different archive image is applied
   when more than one is available; while it runs, confirm all controls visibly
   dim.
6. Click **Choose a wallpaper**, select a supported local image outside the
   archive, and, when the portal honors folder hints, confirm the chooser starts
   in **Archive folder**. Confirm the image is applied without being copied.
   Cancel a second selection and confirm the wallpaper remains unchanged.
7. Click **Check for new wallpapers** and confirm it follows the configured
   **After checking for wallpapers** action. Confirm the next periodic check is
   measured from the manual check.
8. Set the interval to **Every 1 minute**, confirm a subsequent check, then
   restore **Every hour**.
9. Replace `current.json` with another valid state file and confirm the open
   popup and thumbnail refresh.
10. Temporarily rename the current image and confirm the popup remains usable
    without a thumbnail.
11. Use metadata with a long description on a short display and confirm only
    the content region scrolls while the title and status remain visible.
12. Disable the extension and confirm the indicator disappears:

   ```bash
   gnome-extensions disable spotlight-desktop@mosesyyoung
   ```

13. Enable it again and confirm only one indicator and one refresh operation
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
│       ├── prefs.js
│       ├── schemas/
│       │   └── org.gnome.shell.extensions.spotlight-desktop.gschema.xml
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
- [x] Refresh on enable and at configurable intervals without systemd
- [x] Add extension preferences for locale and refresh behavior
- [x] Show the current wallpaper thumbnail in the panel popup
- [x] Add compact title-bar controls for random, manually selected, and
  immediate refresh actions

## Development and testing

Run the automated checks:

```bash
source .venv/bin/activate
python -m unittest discover -s tests -v
python -m py_compile spotlight_downloader.py
node --check gnome-extension/spotlight-desktop@mosesyyoung/extension.js
node --check gnome-extension/spotlight-desktop@mosesyyoung/spotlight.js
node --check gnome-extension/spotlight-desktop@mosesyyoung/prefs.js
glib-compile-schemas --strict --dry-run \
    gnome-extension/spotlight-desktop@mosesyyoung/schemas
sh -n scripts/install-gnome-extension.sh
gnome-extensions pack --force \
    --extra-source=spotlight.js \
    --schema=schemas/org.gnome.shell.extensions.spotlight-desktop.gschema.xml \
    gnome-extension/spotlight-desktop@mosesyyoung
```

The legacy systemd service references the installed CLI path, so verify those
units only after completing the **Legacy systemd refresh** installation:

```bash
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
