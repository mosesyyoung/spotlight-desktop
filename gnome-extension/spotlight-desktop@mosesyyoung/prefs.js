import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


const DEFAULT_ARCHIVE_NAME = 'SpotlightArchive';
const INTERVALS = [
    {value: 0, label: 'Only when enabled'},
    {value: 60, label: 'Every 1 minute'},
    {value: 5 * 60, label: 'Every 5 minutes'},
    {value: 15 * 60, label: 'Every 15 minutes'},
    {value: 30 * 60, label: 'Every 30 minutes'},
    {value: 60 * 60, label: 'Every hour'},
    {value: 3 * 60 * 60, label: 'Every 3 hours'},
    {value: 6 * 60 * 60, label: 'Every 6 hours'},
    {value: 12 * 60 * 60, label: 'Every 12 hours'},
    {value: 24 * 60 * 60, label: 'Once a day'},
];
const WALLPAPER_BEHAVIORS = [
    {value: 'download-only', label: 'Download only'},
    {
        value: 'random-archive',
        label: 'Set a random wallpaper from the archive',
    },
    {
        value: 'new-download',
        label: 'Apply a newly downloaded wallpaper',
    },
];


function defaultArchivePath() {
    const pictures = GLib.get_user_special_dir(
        GLib.UserDirectory.DIRECTORY_PICTURES
    ) ?? GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
    return GLib.build_filenamev([pictures, DEFAULT_ARCHIVE_NAME]);
}


function expandedPath(path) {
    const trimmed = path.trim();
    if (trimmed === '~')
        return GLib.get_home_dir();
    if (trimmed.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), trimmed.slice(2)]);
    return trimmed;
}


function stringList(items) {
    const model = new Gtk.StringList();
    for (const item of items)
        model.append(item.label);
    return model;
}


function selectComboValue(row, items, value) {
    const selected = items.findIndex(item => item.value === value);
    row.selected = selected >= 0 ? selected : 0;
}


export default class SpotlightPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 620);
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: 'Spotlight Desktop',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });
        window.add(page);

        this._addDownloadGroup(page, window, settings);
        this._addScheduleGroup(page, settings);
        this._addWallpaperGroup(page, settings);
    }

    _addDownloadGroup(page, window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Downloads',
            description: 'Choose where and how Spotlight images are requested.',
        });
        page.add(group);

        const defaultPath = defaultArchivePath();
        const configuredPath = settings.get_string('output-directory');
        const outputRow = new Adw.EntryRow({
            title: 'Archive folder',
            text: configuredPath || defaultPath,
        });
        const folderButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: 'Choose archive folder',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        outputRow.add_suffix(folderButton);
        outputRow.connect('changed', row => {
            const path = expandedPath(row.text);
            row.remove_css_class('error');
            if (!path) {
                row.add_css_class('error');
                return;
            }
            settings.set_string(
                'output-directory',
                path === defaultPath ? '' : row.text.trim()
            );
        });
        folderButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose archive folder'});
            const currentPath = expandedPath(outputRow.text);
            if (currentPath)
                dialog.set_initial_folder(Gio.File.new_for_path(currentPath));
            dialog.select_folder(window, null, (source, result) => {
                try {
                    outputRow.text = source.select_folder_finish(result).get_path();
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`Spotlight Desktop: ${error.message}`);
                }
            });
        });
        group.add(outputRow);

        const countRow = Adw.SpinRow.new_with_range(1, 50, 1);
        countRow.title = 'Results per check';
        countRow.subtitle = 'Maximum number of Spotlight results to download';
        countRow.value = settings.get_uint('result-count');
        countRow.connect('notify::value', row => {
            settings.set_uint('result-count', Math.round(row.value));
        });
        group.add(countRow);

        const countryRow = new Adw.EntryRow({
            title: 'Country code',
            text: settings.get_string('country-code'),
        });
        countryRow.connect('changed', row => {
            const country = row.text.trim().toUpperCase();
            row.remove_css_class('error');
            if (!/^[A-Z]{2}$/.test(country)) {
                row.add_css_class('error');
                return;
            }
            settings.set_string('country-code', country);
        });
        group.add(countryRow);

        const localeRow = new Adw.EntryRow({
            title: 'Language and locale',
            text: settings.get_string('locale'),
        });
        localeRow.connect('changed', row => {
            const locale = row.text.trim();
            row.remove_css_class('error');
            if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
                row.add_css_class('error');
                return;
            }
            settings.set_string('locale', locale);
        });
        group.add(localeRow);
    }

    _addScheduleGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Scheduling',
            description: 'A check also runs whenever the extension is enabled.',
        });
        const intervalRow = new Adw.ComboRow({
            title: 'Check for new wallpapers',
            model: stringList(INTERVALS),
        });
        selectComboValue(
            intervalRow,
            INTERVALS,
            settings.get_uint('refresh-interval')
        );
        intervalRow.connect('notify::selected', row => {
            settings.set_uint(
                'refresh-interval',
                INTERVALS[row.selected].value
            );
        });
        group.add(intervalRow);
        page.add(group);
    }

    _addWallpaperGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Wallpaper',
        });
        const behaviorRow = new Adw.ComboRow({
            title: 'After checking for wallpapers',
            model: stringList(WALLPAPER_BEHAVIORS),
        });
        selectComboValue(
            behaviorRow,
            WALLPAPER_BEHAVIORS,
            settings.get_string('wallpaper-behavior')
        );
        behaviorRow.connect('notify::selected', row => {
            settings.set_string(
                'wallpaper-behavior',
                WALLPAPER_BEHAVIORS[row.selected].value
            );
        });
        group.add(behaviorRow);
        page.add(group);
    }
}
