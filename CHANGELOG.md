# Changelog

All notable changes to Spotlight Desktop are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An atomically updated, XDG-compatible `current.json` interface for the active
  wallpaper and its available Spotlight metadata.
- A GNOME Shell 50 panel indicator with a live Spotlight information popup.
- A per-user GNOME extension installer.

### Changed

- Aligned the reported CLI version with the latest `v1.2.0` release.

## [1.2.0] - 2026-08-23

### Added

- `--refresh` mode that applies a wallpaper only when new Spotlight images are
  downloaded.
- A user-level systemd service and hourly timer for scheduled wallpaper
  refreshes.

### Changed

- Download operations now report which image files were added during the
  current run, allowing known archive images to leave the wallpaper unchanged.

## [1.1.0] - 2026-08-23

### Added

- GNOME wallpaper integration for both light and dark appearance settings.
- `--set-wallpaper [IMAGE]` for selecting an archive image or using a specific
  local image without contacting the Spotlight API.
- 3840×2160 image preference with lower-resolution fallback.
- Resolution details in per-image metadata.
- Multi-batch fetching when more than four images are requested.

### Changed

- Renamed the project to Spotlight Desktop.
- Replaced the shared download-history file with per-image metadata scanning.

### Fixed

- Detect dconf write failures even when `gsettings` exits successfully.
- Verify that both GNOME wallpaper settings were committed before reporting
  success.
- Ignore legacy placeholder assets and retry lower-resolution candidates when
  4K downloads fail.

## [1.0.0] - 2026-08-22

### Added

- Initial Microsoft Spotlight API integration.
- Wallpaper downloads with localization, metadata, and duplicate detection.

[Unreleased]: https://github.com/mosesyyoung/spotlight-desktop/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/mosesyyoung/spotlight-desktop/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mosesyyoung/spotlight-desktop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mosesyyoung/spotlight-desktop/releases/tag/v1.0.0
