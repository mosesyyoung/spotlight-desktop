import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';


const STATE_DIRECTORY = 'spotlight-desktop';
const STATE_FILENAME = 'current.json';


export default class SpotlightInformationExtension extends Extension {
    enable() {
        this._currentState = null;
        this._lastReadError = null;
        this._stateDirectory = null;
        this._stateFile = null;
        this._monitor = null;
        this._monitorChangedId = null;

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

        this._setupStateMonitor();
        this._loadState();
    }

    disable() {
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

        this._indicator?.destroy();
        this._indicator = null;
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

        this._indicator.menu.removeAll();
        this._addText('Spotlight', 'spotlight-information-heading');
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (!this._currentState) {
            this._addText(
                'No Spotlight wallpaper information available.',
                'spotlight-information-body'
            );
            return;
        }

        this._addOptionalText(
            this._currentState.title,
            'spotlight-information-title'
        );
        this._addOptionalText(
            this._currentState.location,
            'spotlight-information-location'
        );
        this._addOptionalText(
            this._currentState.description,
            'spotlight-information-body'
        );
        this._addOptionalText(
            this._currentState.copyright,
            'spotlight-information-copyright'
        );

        if (this._hasText(this._currentState.image)) {
            this._addText(
                GLib.path_get_basename(this._currentState.image),
                'spotlight-information-file'
            );
        }
    }

    _addOptionalText(value, styleClass) {
        if (this._hasText(value))
            this._addText(value.trim(), styleClass);
    }

    _hasText(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    _addText(text, styleClass) {
        const item = new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
        });
        item.label.add_style_class_name(styleClass);
        item.label.clutter_text.set_line_wrap(true);
        item.label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this._indicator.menu.addMenuItem(item);
    }
}
