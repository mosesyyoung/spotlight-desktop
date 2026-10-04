import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SpotlightRefresher} from './spotlight.js';


const STATE_DIRECTORY = 'spotlight-desktop';
const STATE_FILENAME = 'current.json';
const THUMBNAIL_WIDTH = 360;
const THUMBNAIL_HEIGHT = 203;
const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop';
const FILE_CHOOSER_INTERFACE = 'org.freedesktop.portal.FileChooser';
const REQUEST_INTERFACE = 'org.freedesktop.portal.Request';
const TOOLTIP_DELAY_MS = 400;
const MENU_FIXED_HEIGHT_RESERVE = 160;


export default class SpotlightInformationExtension extends Extension {
    enable() {
        this._enabled = true;
        this._generation = (this._generation ?? 0) + 1;
        this._currentState = null;
        this._lastReadError = null;
        this._refreshStatus = null;
        this._operationPromise = null;
        this._refreshTimerId = null;
        this._cancellable = null;
        this._refresher = null;
        this._portalRequest = null;
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect(
            'changed::refresh-interval',
            () => this._scheduleRefresh()
        );
        this._stateDirectory = null;
        this._stateFile = null;
        this._monitor = null;
        this._monitorChangedId = null;
        this._thumbnailPath = null;
        this._thumbnailContent = null;
        this._thumbnailLoader = null;
        this._thumbnailLoaderChangedId = null;
        this._tooltips = [];
        this._menuOpenStateChangedId = null;

        this._indicator = new PanelMenu.Button(
            0.0,
            this.metadata.name,
            false
        );
        this._indicator.add_child(new St.Icon({
            icon_name: 'dialog-information-symbolic',
            style_class: 'system-status-icon',
        }));
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._menuOpenStateChangedId = this._indicator.menu.connect(
            'open-state-changed',
            (_menu, open) => {
                if (!open)
                    this._hideTooltips();
            }
        );

        this._setupStateMonitor();
        this._loadState();
        this._startRefresh();
        this._scheduleRefresh();
    }

    disable() {
        this._enabled = false;
        this._generation++;
        if (this._refreshTimerId) {
            GLib.Source.remove(this._refreshTimerId);
            this._refreshTimerId = null;
        }
        this._cancellable?.cancel();
        this._cancelPortalRequest();
        this._refresher?.abort();
        this._cancellable = null;
        this._refresher = null;
        this._operationPromise = null;
        this._refreshStatus = null;
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;

        if (this._monitor && this._monitorChangedId) {
            this._monitor.disconnect(this._monitorChangedId);
            this._monitorChangedId = null;
        }
        this._monitor?.cancel();
        this._monitor = null;
        this._stateFile = null;
        this._stateDirectory = null;
        this._currentState = null;
        this._lastReadError = null;
        this._clearThumbnailCache();
        this._clearTooltips();

        if (this._indicator?.menu && this._menuOpenStateChangedId) {
            this._indicator.menu.disconnect(this._menuOpenStateChangedId);
            this._menuOpenStateChangedId = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
    }

    _scheduleRefresh() {
        if (this._refreshTimerId) {
            GLib.Source.remove(this._refreshTimerId);
            this._refreshTimerId = null;
        }
        if (!this._enabled || !this._settings)
            return;

        const interval = this._settings.get_uint('refresh-interval');
        if (interval === 0)
            return;
        this._refreshTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._startRefresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _startRefresh(resetSchedule = false) {
        if (!this._enabled || this._operationPromise)
            return;

        if (resetSchedule)
            this._scheduleRefresh();

        const generation = this._generation;
        const cancellable = new Gio.Cancellable();
        const refresher = this._newRefresher();
        this._cancellable = cancellable;
        this._refresher = refresher;
        const operation = this._runRefresh(
            generation,
            refresher,
            cancellable
        );
        this._beginOperation(
            operation,
            refresher,
            cancellable,
            'Checking for new wallpapers…'
        );
    }

    async _runRefresh(generation, refresher, cancellable) {
        try {
            const result = await refresher.refresh(cancellable);
            if (!this._enabled || generation !== this._generation)
                return;

            if (result.applied === 'random-archive') {
                this._refreshStatus = result.downloaded > 0
                    ? `Downloaded ${result.downloaded} new ${this._wallpaperNoun(result.downloaded)} and applied a random archive wallpaper.`
                    : 'Applied a random wallpaper from the archive.';
            } else if (result.applied === 'new-download') {
                this._refreshStatus =
                    `Downloaded and applied ${result.downloaded} new ${this._wallpaperNoun(result.downloaded)}.`;
            } else if (result.downloaded > 0) {
                const noun = result.downloaded === 1 ? 'wallpaper' : 'wallpapers';
                this._refreshStatus =
                    `Downloaded ${result.downloaded} new ${noun}; wallpaper unchanged.`;
            } else {
                this._refreshStatus = 'No new wallpapers found.';
            }
        } catch (error) {
            if (!this._enabled || generation !== this._generation)
                return;
            this._refreshStatus = `Refresh failed: ${error.message}`;
            console.error(`Spotlight Desktop: refresh failed: ${error.message}`);
        }
        this._renderMenu();
    }

    _beginOperation(operation, refresher, cancellable, status) {
        this._operationPromise = operation;
        this._cancellable = cancellable;
        this._refresher = refresher;
        this._refreshStatus = status;
        this._renderMenu();

        const clearOperation = () => {
            if (this._operationPromise !== operation)
                return;
            this._operationPromise = null;
            this._cancellable = null;
            this._refresher = null;
            if (this._enabled)
                this._renderMenu();
        };
        operation.then(clearOperation, error => {
            clearOperation();
            console.error(
                `Spotlight Desktop: unexpected operation error: ${error.message}`
            );
        });
    }

    _newRefresher() {
        return new SpotlightRefresher({
            output: this._settings.get_string('output-directory'),
            count: this._settings.get_uint('result-count'),
            country: this._settings.get_string('country-code'),
            locale: this._settings.get_string('locale'),
            wallpaperBehavior: this._settings.get_string(
                'wallpaper-behavior'
            ),
        });
    }

    _startRandomWallpaper() {
        if (!this._enabled || this._operationPromise)
            return;

        const generation = this._generation;
        const cancellable = new Gio.Cancellable();
        const refresher = this._newRefresher();
        const operation = this._runWallpaperAction(
            generation,
            () => refresher.applyRandomArchiveWallpaper(
                cancellable,
                this._currentState?.image ?? null
            ),
            'Applied a random wallpaper from the archive.'
        );
        this._beginOperation(
            operation,
            refresher,
            cancellable,
            'Selecting a random archive wallpaper…'
        );
    }

    _startChooseWallpaper() {
        if (!this._enabled || this._operationPromise)
            return;

        const generation = this._generation;
        const cancellable = new Gio.Cancellable();
        const refresher = this._newRefresher();
        const operation = this._runWallpaperAction(
            generation,
            async () => {
                const imageFile = await this._chooseWallpaperFile(
                    cancellable,
                    refresher.outputDirectory
                );
                if (!imageFile)
                    return false;
                await refresher.applyLocalWallpaper(imageFile, cancellable);
                return true;
            },
            'Applied the selected wallpaper.',
            'Wallpaper selection cancelled.'
        );
        this._beginOperation(
            operation,
            refresher,
            cancellable,
            'Choose a wallpaper…'
        );
    }

    async _runWallpaperAction(
        generation,
        action,
        successStatus,
        cancelledStatus = null
    ) {
        try {
            const result = await action();
            if (!this._enabled || generation !== this._generation)
                return;
            this._refreshStatus = result === false
                ? cancelledStatus
                : successStatus;
        } catch (error) {
            if (!this._enabled || generation !== this._generation)
                return;
            this._refreshStatus = `Wallpaper action failed: ${error.message}`;
            console.error(
                `Spotlight Desktop: wallpaper action failed: ${error.message}`
            );
        }
        this._renderMenu();
    }

    _chooseWallpaperFile(cancellable, outputDirectory) {
        return new Promise((resolve, reject) => {
            const connection = Gio.DBus.session;
            const token = `spotlight_${GLib.uuid_string_random().replaceAll('-', '_')}`;
            const sender = connection.get_unique_name()
                .slice(1)
                .replaceAll('.', '_');
            const expectedPath =
                `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
            const filters = [[
                'Images',
                [
                    [1, 'image/jpeg'],
                    [1, 'image/png'],
                    [1, 'image/webp'],
                ],
            ]];
            const request = {
                path: expectedPath,
                signalId: 0,
                cancellableId: 0,
                settled: false,
            };

            const cleanup = () => {
                if (request.signalId) {
                    connection.signal_unsubscribe(request.signalId);
                    request.signalId = 0;
                }
                if (request.cancellableId) {
                    cancellable.disconnect(request.cancellableId);
                    request.cancellableId = 0;
                }
                if (this._portalRequest === request)
                    this._portalRequest = null;
            };
            const settle = (callback, value) => {
                if (request.settled)
                    return;
                request.settled = true;
                cleanup();
                callback(value);
            };
            request.cancel = () => {
                this._closePortalRequest(request);
                settle(reject, new Error('file selection was cancelled'));
            };
            const subscribe = path => connection.signal_subscribe(
                PORTAL_BUS_NAME,
                REQUEST_INTERFACE,
                'Response',
                path,
                null,
                Gio.DBusSignalFlags.NONE,
                (_connection, _senderName, _objectPath, _interfaceName,
                    _signalName, parameters) => {
                    const [response, results] = parameters.deep_unpack();
                    if (response !== 0) {
                        settle(resolve, null);
                        return;
                    }
                    const urisValue = results.uris;
                    const uris = urisValue?.deep_unpack?.() ?? urisValue ?? [];
                    if (!Array.isArray(uris) || uris.length === 0) {
                        settle(
                            reject,
                            new Error('the file chooser returned no image')
                        );
                        return;
                    }
                    const file = Gio.File.new_for_uri(uris[0]);
                    if (!file.get_path()) {
                        settle(
                            reject,
                            new Error('only local wallpaper files are supported')
                        );
                        return;
                    }
                    settle(resolve, file);
                }
            );

            request.signalId = subscribe(expectedPath);
            request.cancellableId = cancellable.connect(() => request.cancel());
            this._portalRequest = request;

            const options = {
                handle_token: new GLib.Variant('s', token),
                modal: new GLib.Variant('b', true),
                multiple: new GLib.Variant('b', false),
                directory: new GLib.Variant('b', false),
                filters: new GLib.Variant('a(sa(us))', filters),
                current_folder: new GLib.Variant(
                    'ay',
                    new TextEncoder().encode(
                        `${this._prepareChooserDirectory(outputDirectory)}\0`
                    )
                ),
            };
            connection.call(
                PORTAL_BUS_NAME,
                PORTAL_OBJECT_PATH,
                FILE_CHOOSER_INTERFACE,
                'OpenFile',
                new GLib.Variant('(ssa{sv})', [
                    '',
                    'Choose a wallpaper',
                    options,
                ]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                -1,
                cancellable,
                (source, result) => {
                    if (request.settled)
                        return;
                    try {
                        const [returnedPath] = source.call_finish(result)
                            .deep_unpack();
                        request.path = returnedPath;
                        if (returnedPath !== expectedPath) {
                            const previousSignalId = request.signalId;
                            request.signalId = subscribe(returnedPath);
                            connection.signal_unsubscribe(previousSignalId);
                        }
                    } catch (error) {
                        settle(reject, error);
                    }
                }
            );
        });
    }

    _prepareChooserDirectory(outputDirectory) {
        const picturesPath = GLib.get_user_special_dir(
            GLib.UserDirectory.DIRECTORY_PICTURES
        );
        const candidates = [
            outputDirectory,
            picturesPath ? Gio.File.new_for_path(picturesPath) : null,
            Gio.File.new_for_path(GLib.get_home_dir()),
        ];
        const checked = new Set();

        for (const candidate of candidates) {
            const path = candidate?.get_path?.();
            if (!path || checked.has(path))
                continue;
            checked.add(path);
            try {
                GLib.mkdir_with_parents(path, 0o755);
                const info = candidate.query_info(
                    'standard::type,access::can-read',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                if (info.get_file_type() === Gio.FileType.DIRECTORY &&
                    info.get_attribute_boolean('access::can-read'))
                    return path;
            } catch (error) {
                console.debug(
                    `Spotlight Desktop: could not use chooser directory ${path}: ${error.message}`
                );
            }
        }
        return GLib.get_home_dir();
    }

    _closePortalRequest(request) {
        if (!request?.path || request.settled)
            return;
        Gio.DBus.session.call(
            PORTAL_BUS_NAME,
            request.path,
            REQUEST_INTERFACE,
            'Close',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    _cancelPortalRequest() {
        const request = this._portalRequest;
        if (!request)
            return;
        request.cancel();
    }

    _wallpaperNoun(count) {
        return count === 1 ? 'wallpaper' : 'wallpapers';
    }

    _setupStateMonitor() {
        const stateDirectoryPath = GLib.build_filenamev([
            GLib.get_user_state_dir(),
            STATE_DIRECTORY,
        ]);

        try {
            if (GLib.mkdir_with_parents(stateDirectoryPath, 0o700) < 0)
                throw new Error(`Could not create ${stateDirectoryPath}`);

            this._stateDirectory = Gio.File.new_for_path(stateDirectoryPath);
            this._stateFile = this._stateDirectory.get_child(STATE_FILENAME);
            this._monitor = this._stateDirectory.monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES,
                null
            );
            this._monitorChangedId = this._monitor.connect(
                'changed',
                (_monitor, file, otherFile) => {
                    if (this._isStateFile(file) || this._isStateFile(otherFile))
                        this._loadState();
                }
            );
        } catch (error) {
            console.error(`Spotlight Information: ${error.message}`);
        }
    }

    _isStateFile(file) {
        return file?.get_basename() === STATE_FILENAME;
    }

    _loadState() {
        if (!this._stateFile || !this._stateFile.query_exists(null)) {
            this._currentState = null;
            this._lastReadError = null;
            this._renderMenu();
            return;
        }

        try {
            const [loaded, contents] = this._stateFile.load_contents(null);
            if (!loaded)
                throw new Error(`Could not read ${this._stateFile.get_path()}`);

            const state = JSON.parse(new TextDecoder().decode(contents));
            if (!state || typeof state !== 'object' || Array.isArray(state))
                throw new Error('current.json must contain a JSON object');

            this._currentState = state;
            this._lastReadError = null;
            this._renderMenu();
        } catch (error) {
            const message = `Could not load current.json: ${error.message}`;
            if (message !== this._lastReadError)
                console.error(`Spotlight Information: ${message}`);
            this._lastReadError = message;

            if (!this._currentState)
                this._renderMenu();
        }
    }

    _renderMenu() {
        if (!this._indicator)
            return;

        const imagePath = this._hasText(this._currentState?.image)
            ? this._currentState.image.trim()
            : null;
        this._prepareThumbnail(imagePath);

        this._clearTooltips();
        this._indicator.menu.removeAll();
        this._addHeader();
        if (this._hasText(this._refreshStatus))
            this._addText(this._refreshStatus, 'spotlight-information-status');
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        if (!this._currentState) {
            this._addText(
                'No Spotlight wallpaper information available.',
                'spotlight-information-body',
                content
            );
            this._addScrollableContent(content);
            return;
        }

        this._addOptionalText(
            this._currentState.title,
            'spotlight-information-title',
            content
        );
        this._addOptionalText(
            this._currentState.location,
            'spotlight-information-location',
            content
        );
        this._addOptionalText(
            this._currentState.description,
            'spotlight-information-body',
            content
        );
        this._addOptionalText(
            this._currentState.copyright,
            'spotlight-information-copyright',
            content
        );

        if (imagePath) {
            this._addThumbnail(content);
            this._addText(
                GLib.path_get_basename(imagePath),
                'spotlight-information-file',
                content
            );
        }
        this._addScrollableContent(content);
    }

    _addHeader() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_style_class_name('spotlight-information-header');
        const heading = new St.Label({
            text: 'Spotlight',
            style_class: 'spotlight-information-heading',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        const controls = new St.BoxLayout({
            style_class: 'spotlight-information-controls',
        });
        controls.add_child(this._controlButton(
            'media-playlist-shuffle-symbolic',
            'Random wallpaper',
            () => this._startRandomWallpaper()
        ));
        controls.add_child(this._controlButton(
            'document-open-symbolic',
            'Choose a wallpaper',
            () => this._startChooseWallpaper()
        ));
        controls.add_child(this._controlButton(
            'view-refresh-symbolic',
            'Check for new wallpapers',
            () => this._startRefresh(true)
        ));
        item.add_child(heading);
        item.add_child(controls);
        this._indicator.menu.addMenuItem(item);
    }

    _controlButton(iconName, label, callback) {
        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: 16,
        });

        const button = new St.Button({
            style_class: 'spotlight-information-control-button',
            child: icon,
            reactive: !this._operationPromise,
            can_focus: !this._operationPromise,
            track_hover: true,
        });
        button.set_accessible_name(label);
        button.add_style_class_name(this._operationPromise
            ? 'spotlight-information-control-button-disabled'
            : 'spotlight-information-control-button-enabled');
        button.connect('clicked', callback);
        this._attachTooltip(button, label);
        return button;
    }

    _addScrollableContent(content) {
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.primaryIndex
        );
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage)
            .scale_factor;
        const maximumHeight = Math.max(
            120,
            Math.round(workArea.height / scaleFactor - MENU_FIXED_HEIGHT_RESERVE)
        );
        const scrollView = new St.ScrollView({
            style_class: 'spotlight-information-scroll-view',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            child: content,
        });
        scrollView.style = `max-height: ${maximumHeight}px;`;

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_style_class_name('spotlight-information-scroll-item');
        item.add_child(scrollView);
        this._indicator.menu.addMenuItem(item);
    }

    _attachTooltip(button, text) {
        const label = new St.Label({
            text,
            style_class: 'dash-label spotlight-information-tooltip',
            visible: false,
            opacity: 0,
        });
        Main.uiGroup.add_child(label);
        const tooltip = {button, label, timeoutId: 0, hoverId: 0};
        this._tooltips.push(tooltip);

        tooltip.hoverId = button.connect('notify::hover', () => {
            if (button.hover && button.reactive)
                this._showTooltip(tooltip);
            else
                this._hideTooltip(tooltip);
        });
    }

    _showTooltip(tooltip) {
        if (tooltip.timeoutId)
            return;
        if (tooltip.label.visible) {
            tooltip.label.remove_all_transitions();
            tooltip.label.ease({
                opacity: 255,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return;
        }

        tooltip.timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TOOLTIP_DELAY_MS,
            () => {
                tooltip.timeoutId = 0;
                if (!tooltip.button.hover || !tooltip.button.reactive)
                    return GLib.SOURCE_REMOVE;

                tooltip.label.opacity = 0;
                tooltip.label.show();
                const extents = tooltip.button.get_transformed_extents();
                const xOffset = Math.floor(
                    (extents.get_width() - tooltip.label.width) / 2
                );
                const x = Math.clamp(
                    extents.get_x() + xOffset,
                    0,
                    global.stage.width - tooltip.label.width
                );
                const y = Math.clamp(
                    extents.get_y() + extents.get_height() + 8,
                    0,
                    global.stage.height - tooltip.label.height
                );
                tooltip.label.set_position(x, y);
                tooltip.label.ease({
                    opacity: 255,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                return GLib.SOURCE_REMOVE;
            }
        );
        GLib.Source.set_name_by_id(
            tooltip.timeoutId,
            '[spotlight-desktop] tooltip.open'
        );
    }

    _hideTooltip(tooltip) {
        if (tooltip.timeoutId) {
            GLib.Source.remove(tooltip.timeoutId);
            tooltip.timeoutId = 0;
        }
        if (!tooltip.label.visible)
            return;

        tooltip.label.remove_all_transitions();
        tooltip.label.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => tooltip.label.hide(),
        });
    }

    _hideTooltips() {
        for (const tooltip of this._tooltips)
            this._hideTooltip(tooltip);
    }

    _clearTooltips() {
        for (const tooltip of this._tooltips) {
            if (tooltip.timeoutId)
                GLib.Source.remove(tooltip.timeoutId);
            if (tooltip.hoverId)
                tooltip.button.disconnect(tooltip.hoverId);
            tooltip.label.remove_all_transitions();
            tooltip.label.destroy();
        }
        this._tooltips = [];
    }

    _prepareThumbnail(imagePath) {
        if (imagePath !== this._thumbnailPath) {
            this._clearThumbnailCache();
            this._thumbnailPath = imagePath;
        }
        if (!imagePath || this._thumbnailContent || this._thumbnailLoader)
            return;

        const file = Gio.File.new_for_path(imagePath);
        if (!file.query_exists(null))
            return;

        try {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const resourceScale = this._indicator.get_resource_scale();
            const loader = St.TextureCache.get_default().load_file_async(
                file,
                THUMBNAIL_WIDTH,
                THUMBNAIL_HEIGHT,
                themeContext.scale_factor,
                resourceScale
            );
            this._thumbnailLoader = loader;
            if (loader.content) {
                this._storeThumbnailContent(loader);
                return;
            }
            this._thumbnailLoaderChangedId = loader.connect(
                'notify::content',
                actor => {
                    if (actor !== this._thumbnailLoader || !actor.content)
                        return;
                    this._storeThumbnailContent(actor);
                    if (this._enabled)
                        this._renderMenu();
                }
            );
        } catch (error) {
            console.error(
                `Spotlight Information: could not load thumbnail: ${error.message}`
            );
        }
    }

    _storeThumbnailContent(loader) {
        const content = loader.content;
        if (!content)
            return;
        if (this._thumbnailLoaderChangedId) {
            loader.disconnect(this._thumbnailLoaderChangedId);
            this._thumbnailLoaderChangedId = null;
        }
        loader.content = null;
        loader.destroy();
        this._thumbnailLoader = null;
        this._thumbnailContent = content;
    }

    _clearThumbnailCache() {
        if (this._thumbnailLoader && this._thumbnailLoaderChangedId) {
            this._thumbnailLoader.disconnect(
                this._thumbnailLoaderChangedId
            );
        }
        this._thumbnailLoaderChangedId = null;
        if (this._thumbnailLoader) {
            this._thumbnailLoader.content = null;
            this._thumbnailLoader.destroy();
            this._thumbnailLoader = null;
        }
        this._thumbnailContent = null;
        this._thumbnailPath = null;
    }

    _addThumbnail(target) {
        if (!this._thumbnailContent)
            return;

        try {
            const thumbnail = new Clutter.Actor({
                content: this._thumbnailContent,
                width: THUMBNAIL_WIDTH,
                height: THUMBNAIL_HEIGHT,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const frame = new St.Bin({
                style_class: 'spotlight-information-thumbnail-frame',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                clip_to_allocation: true,
                child: thumbnail,
            });
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            item.add_style_class_name(
                'spotlight-information-thumbnail-item'
            );
            item.add_child(frame);
            target.add_child(item);
        } catch (error) {
            console.error(
                `Spotlight Information: could not load thumbnail: ${error.message}`
            );
        }
    }

    _addOptionalText(value, styleClass, target = null) {
        if (this._hasText(value))
            this._addText(value.trim(), styleClass, target);
    }

    _hasText(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    _addText(text, styleClass, target = null) {
        const item = new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
        });
        if (target) {
            item.add_style_class_name(
                'spotlight-information-content-item'
            );
        }
        item.label.add_style_class_name(styleClass);
        item.label.clutter_text.set_line_wrap(true);
        item.label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        if (target)
            target.add_child(item);
        else
            this._indicator.menu.addMenuItem(item);
    }
}
