import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';


const API_URL = 'https://fd.api.iris.microsoft.com/v4/api/selection';
const FALLBACK_API_URL = 'https://arc.msn.com/v3/Delivery/Placement';
const PREFERRED_WIDTH = 3840;
const PREFERRED_HEIGHT = 2160;
const API_BATCH_SIZE = 4;
const MAX_STALE_BATCHES = 5;
const DEFAULT_COUNT = 10;
const DEFAULT_COUNTRY = 'CN';
const DEFAULT_LOCALE = 'zh-CN';
const DEFAULT_WALLPAPER_BEHAVIOR = 'new-download';
const WALLPAPER_BEHAVIORS = new Set([
    'download-only',
    'random-archive',
    'new-download',
]);
const MAX_REQUEST_ATTEMPTS = 3;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) SpotlightDesktop/1.4';
const IMAGE_ATTRIBUTES = 'standard::name,standard::type';
const RESOLUTION_PATTERN = /(?:^|\D)(\d{3,5})x(\d{3,5})(?!\d)/gi;


Gio._promisify(
    Soup.Session.prototype,
    'send_and_read_async',
    'send_and_read_finish'
);
Gio._promisify(
    Gio.File.prototype,
    'enumerate_children_async',
    'enumerate_children_finish'
);
Gio._promisify(
    Gio.FileEnumerator.prototype,
    'next_files_async',
    'next_files_finish'
);
Gio._promisify(
    Gio.FileEnumerator.prototype,
    'close_async',
    'close_finish'
);
Gio._promisify(
    Gio.File.prototype,
    'load_contents_async',
    'load_contents_finish'
);
Gio._promisify(
    Gio.File.prototype,
    'replace_contents_async',
    'replace_contents_finish'
);


function queryUrl(base, parameters) {
    const query = Object.entries(parameters)
        .map(([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    return `${base}?${query}`;
}


function validText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}


function resolutionFromUrl(url) {
    let match = null;
    for (const candidate of url.matchAll(RESOLUTION_PATTERN))
        match = candidate;
    return match ? [Number(match[1]), Number(match[2])] : [null, null];
}


function positiveDimension(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}


function makeCandidate(asset) {
    let url;
    let width = null;
    let height = null;

    if (typeof asset === 'string') {
        url = asset;
    } else if (asset && typeof asset === 'object') {
        url = asset.asset ?? asset.u ?? asset.url;
        width = positiveDimension(asset.width ?? asset.w);
        height = positiveDimension(asset.height ?? asset.h);
    }

    if (!validText(url) || !url.toLowerCase().startsWith('https://'))
        return null;
    const filename = url.split(/[?#]/, 1)[0].split('/').at(-1);
    if (/(?:^|_)empty\.(?:jpe?g|png)$/i.test(filename))
        return null;

    if (!width || !height) {
        const [hintedWidth, hintedHeight] = resolutionFromUrl(url);
        width ||= hintedWidth;
        height ||= hintedHeight;
    }
    return {url, width, height};
}


function candidateRank(candidate) {
    if (!candidate.width || !candidate.height)
        return [1, 0];
    const exact4k = candidate.width === PREFERRED_WIDTH &&
        candidate.height === PREFERRED_HEIGHT;
    return [exact4k ? 3 : 2, candidate.width * candidate.height];
}


function landscapeCandidates(ad) {
    const assets = [];
    if ('landscapeImage' in ad)
        assets.push(ad.landscapeImage);

    const legacyKeys = Object.keys(ad)
        .filter(key => /^image_fullscreen_\d+_landscape$/.test(key))
        .sort();
    assets.push(...legacyKeys.map(key => ad[key]));

    const seen = new Set();
    const candidates = [];
    for (const asset of assets) {
        const candidate = makeCandidate(asset);
        if (candidate && !seen.has(candidate.url)) {
            seen.add(candidate.url);
            candidates.push(candidate);
        }
    }

    return candidates.sort((left, right) => {
        const leftRank = candidateRank(left);
        const rightRank = candidateRank(right);
        return rightRank[0] - leftRank[0] || rightRank[1] - leftRank[1];
    });
}


function parseImages(items) {
    const images = [];
    if (!Array.isArray(items))
        return images;

    for (const item of items) {
        try {
            const raw = item.item;
            const object = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const ad = object?.ad ?? {};
            const candidates = landscapeCandidates(ad);
            if (candidates.length === 0)
                continue;

            const legacyTitle = ad.title_text;
            const legacyCopyright = ad.copyright_text;
            images.push({
                url: candidates[0].url,
                candidates,
                title: ad.title ?? legacyTitle?.tx ?? null,
                copyright: ad.copyright ?? legacyCopyright?.tx ?? null,
                description: ad.description ?? null,
            });
        } catch (error) {
            console.debug(`Spotlight Desktop: ignored malformed API item: ${error.message}`);
        }
    }
    return images;
}


function metadataUrls(metadata) {
    const urls = [];
    if (validText(metadata?.url))
        urls.push(metadata.url);
    if (Array.isArray(metadata?.candidates)) {
        for (const candidate of metadata.candidates) {
            if (validText(candidate?.url) && !urls.includes(candidate.url))
                urls.push(candidate.url);
        }
    }
    return urls;
}


function isCancelled(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}


function nowIso8601() {
    return GLib.DateTime.new_now_local().format_iso8601();
}


function defaultArchiveDirectory() {
    const pictures = GLib.get_user_special_dir(
        GLib.UserDirectory.DIRECTORY_PICTURES
    ) ?? GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
    return Gio.File.new_for_path(
        GLib.build_filenamev([pictures, 'SpotlightArchive'])
    );
}


function archiveDirectory(configuredPath) {
    if (!validText(configuredPath))
        return defaultArchiveDirectory();

    let path = configuredPath.trim();
    if (path === '~')
        path = GLib.get_home_dir();
    else if (path.startsWith('~/'))
        path = GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    else if (!GLib.path_is_absolute(path))
        path = GLib.build_filenamev([GLib.get_home_dir(), path]);
    return Gio.File.new_for_path(GLib.canonicalize_filename(path, null));
}


function currentStateFile() {
    const stateHome = GLib.getenv('XDG_STATE_HOME') ??
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    return Gio.File.new_for_path(GLib.build_filenamev([
        stateHome,
        'spotlight-desktop',
        'current.json',
    ]));
}


function delay(seconds, cancellable) {
    return new Promise((resolve, reject) => {
        if (cancellable.is_cancelled()) {
            reject(new Error('refresh was cancelled'));
            return;
        }
        let cancelledId = 0;
        const sourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            seconds,
            () => {
                if (cancelledId)
                    cancellable.disconnect(cancelledId);
                resolve();
                return GLib.SOURCE_REMOVE;
            }
        );
        cancelledId = cancellable.connect(() => {
            GLib.Source.remove(sourceId);
            reject(new Error('refresh was cancelled'));
        });
    });
}


async function replaceContents(file, contents, cancellable) {
    await file.replace_contents_async(
        contents,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        cancellable
    );
}


export class SpotlightRefresher {
    constructor(params = {}) {
        this._count = Number.isInteger(params.count) && params.count >= 1 &&
            params.count <= 50 ? params.count : DEFAULT_COUNT;
        this._country = /^[A-Za-z]{2}$/.test(params.country ?? '')
            ? params.country.toUpperCase()
            : DEFAULT_COUNTRY;
        this._locale = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(
            params.locale ?? ''
        ) ? params.locale : DEFAULT_LOCALE;
        this._output = params.output?.get_path
            ? params.output
            : archiveDirectory(params.output);
        this._wallpaperBehavior = WALLPAPER_BEHAVIORS.has(
            params.wallpaperBehavior
        ) ? params.wallpaperBehavior : DEFAULT_WALLPAPER_BEHAVIOR;
        this._stateFile = currentStateFile();
        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: 90,
        });
        this._history = new Map();
        this._archiveImages = new Map();
    }

    abort() {
        this._session.abort();
    }

    async refresh(cancellable) {
        this._ensureDirectories();
        await this._loadHistory(cancellable);

        let images;
        let usedFallback = false;
        try {
            images = await this._getPreferredImages(cancellable);
            if (images.length === 0)
                throw new Error('the preferred API returned no usable images');
        } catch (error) {
            if (isCancelled(error))
                throw error;
            console.warn(`Spotlight Desktop: preferred API failed: ${error.message}`);
            images = await this._getFallbackImages(cancellable);
            usedFallback = true;
        }

        if (images.length === 0)
            throw new Error('Spotlight APIs returned no usable images');

        let downloaded = [];
        const failures = [];
        for (const image of images) {
            try {
                const file = await this._downloadImage(image, cancellable);
                if (file)
                    downloaded.push({file, metadata: image});
            } catch (error) {
                if (isCancelled(error))
                    throw error;
                failures.push(error);
                console.warn(`Spotlight Desktop: download failed: ${error.message}`);
            }
        }

        if (failures.length > 0 && !usedFallback) {
            try {
                const fallback = await this._getFallbackImages(cancellable);
                let replacementsNeeded = Math.max(
                    0,
                    Math.min(failures.length, this._count - downloaded.length)
                );
                for (const image of fallback) {
                    if (replacementsNeeded === 0)
                        break;
                    try {
                        const file = await this._downloadImage(image, cancellable);
                        if (file) {
                            downloaded.push({file, metadata: image});
                            replacementsNeeded--;
                        }
                    } catch (error) {
                        if (isCancelled(error))
                            throw error;
                        console.warn(`Spotlight Desktop: fallback download failed: ${error.message}`);
                    }
                }
            } catch (error) {
                if (isCancelled(error))
                    throw error;
                console.warn(`Spotlight Desktop: fallback API failed: ${error.message}`);
            }
        }

        if (this._wallpaperBehavior === 'new-download' &&
            downloaded.length > 0) {
            const selected = downloaded[Math.floor(Math.random() * downloaded.length)];
            await this._applyWallpaper(selected.file, selected.metadata, cancellable);
            return {applied: 'new-download', downloaded: downloaded.length};
        }

        if (this._wallpaperBehavior === 'random-archive' &&
            this._archiveImages.size > 0) {
            const archived = [...this._archiveImages.values()];
            const selected = archived[Math.floor(Math.random() * archived.length)];
            await this._applyWallpaper(selected.file, selected.metadata, cancellable);
            return {applied: 'random-archive', downloaded: downloaded.length};
        }

        if (downloaded.length === 0 && failures.length === images.length)
            throw new Error('all wallpaper downloads failed');
        return {applied: null, downloaded: downloaded.length};
    }

    _ensureDirectories() {
        const stateDirectory = this._stateFile.get_parent();
        for (const directory of [this._output, stateDirectory]) {
            try {
                directory.make_directory_with_parents(null);
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw error;
            }
        }
        GLib.chmod(stateDirectory.get_path(), 0o700);
    }

    async _loadHistory(cancellable) {
        this._history.clear();
        this._archiveImages.clear();
        const enumerator = await this._output.enumerate_children_async(
            IMAGE_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );

        try {
            while (true) {
                const infos = await enumerator.next_files_async(
                    64,
                    GLib.PRIORITY_DEFAULT,
                    cancellable
                );
                if (infos.length === 0)
                    break;

                for (const info of infos) {
                    const name = info.get_name();
                    if (info.get_file_type() !== Gio.FileType.REGULAR)
                        continue;

                    if (/\.(?:jpe?g|png|webp)$/i.test(name)) {
                        const imageFile = this._output.get_child(name);
                        const archived = this._archiveImages.get(
                            imageFile.get_path()
                        );
                        this._archiveImages.set(
                            imageFile.get_path(),
                            {file: imageFile, metadata: archived?.metadata ?? null}
                        );
                        continue;
                    }
                    if (!/\.(?:jpe?g|png|webp)\.json$/i.test(name))
                        continue;

                    const metadataFile = this._output.get_child(name);
                    const imageFile = this._output.get_child(name.slice(0, -5));
                    if (!imageFile.query_exists(cancellable))
                        continue;
                    try {
                        const [contents] = await metadataFile.load_contents_async(cancellable);
                        const metadata = JSON.parse(new TextDecoder().decode(contents));
                        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
                            continue;
                        const urls = metadataUrls(metadata);
                        for (const url of urls)
                            this._history.set(url, imageFile);
                        this._archiveImages.set(
                            imageFile.get_path(),
                            {file: imageFile, metadata}
                        );
                    } catch (error) {
                        if (isCancelled(error))
                            throw error;
                        console.warn(`Spotlight Desktop: ignored invalid ${name}: ${error.message}`);
                    }
                }
            }
        } finally {
            await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
        }
    }

    async _getPreferredImages(cancellable) {
        const images = [];
        const seen = new Set();
        let staleBatches = 0;

        while (images.length < this._count && staleBatches < MAX_STALE_BATCHES) {
            const count = Math.min(API_BATCH_SIZE, this._count - images.length);
            const response = await this._getJson(queryUrl(API_URL, {
                placement: '88000820',
                bcnt: count,
                country: this._country,
                locale: this._locale,
                fmt: 'json',
            }), cancellable);
            const parsed = parseImages(response?.batchrsp?.items);
            let added = 0;
            for (const image of parsed) {
                if (!seen.has(image.url)) {
                    seen.add(image.url);
                    images.push(image);
                    added++;
                    if (images.length === this._count)
                        break;
                }
            }
            staleBatches = added > 0 ? 0 : staleBatches + 1;
        }
        return images;
    }

    async _getFallbackImages(cancellable) {
        const now = GLib.DateTime.new_now_utc().format('%Y-%m-%dT%H:%M:%SZ');
        const response = await this._getJson(queryUrl(FALLBACK_API_URL, {
            pid: '338387',
            fmt: 'json',
            ua: 'WindowsShellClient/0',
            cdm: '1',
            pl: this._locale,
            lc: this._locale,
            ctry: this._country,
            time: now,
        }), cancellable);
        return parseImages(response?.batchrsp?.items).slice(0, this._count);
    }

    async _getJson(url, cancellable) {
        const bytes = await this._request(url, cancellable);
        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
            throw new Error(`API returned invalid JSON: ${error.message}`);
        }
    }

    async _request(url, cancellable) {
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
            let retryable = true;
            try {
                const message = Soup.Message.new('GET', url);
                if (!message)
                    throw new Error(`could not create request for ${url}`);
                message.get_request_headers().append(
                    'Accept',
                    'image/avif,image/webp,image/apng,image/*,application/json;q=0.9,*/*;q=0.8'
                );

                const bytes = await this._session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    cancellable
                );
                const status = message.get_status();
                if (status >= 200 && status < 300)
                    return bytes.get_data();
                retryable = status === 429 || status >= 500;
                throw new Error(`HTTP ${status} from ${url}`);
            } catch (error) {
                if (cancellable.is_cancelled() || isCancelled(error))
                    throw error;
                lastError = error;
            }

            if (!retryable || attempt === MAX_REQUEST_ATTEMPTS)
                break;
            await delay(attempt, cancellable);
        }
        throw lastError;
    }

    async _downloadImage(item, cancellable) {
        const candidates = (item.candidates ?? [makeCandidate(item.url)])
            .filter(candidate => candidate);
        if (candidates.length === 0)
            throw new Error('image has no usable download URL');
        if (candidates.some(candidate => this._history.has(candidate.url)))
            return null;

        const failures = [];
        for (const candidate of candidates) {
            try {
                const bytes = await this._request(candidate.url, cancellable);
                if (bytes.length === 0)
                    throw new Error('server returned an empty image');
                const [width, height] = this._imageDimensions(bytes);
                const hash = GLib.compute_checksum_for_string(
                    GLib.ChecksumType.SHA256,
                    candidate.url,
                    -1
                ).slice(0, 8);
                const timestamp = GLib.DateTime.new_now_local()
                    .format('%Y%m%d_%H%M%S');
                const filename = `${timestamp}_${hash}.jpg`;
                const imageFile = this._output.get_child(filename);
                const metadataFile = this._output.get_child(`${filename}.json`);
                const metadata = {
                    ...item,
                    url: candidate.url,
                    width,
                    height,
                    resolution: `${width}x${height}`,
                    is_4k: width >= PREFERRED_WIDTH && height >= PREFERRED_HEIGHT,
                    download_time: nowIso8601(),
                    file: filename,
                };

                await replaceContents(imageFile, bytes, cancellable);
                await replaceContents(
                    metadataFile,
                    new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`),
                    cancellable
                );
                for (const url of metadataUrls(metadata))
                    this._history.set(url, imageFile);
                this._archiveImages.set(imageFile.get_path(), {file: imageFile, metadata});
                item.url = metadata.url;
                item.width = width;
                item.height = height;
                return imageFile;
            } catch (error) {
                if (isCancelled(error))
                    throw error;
                failures.push(`${candidate.url}: ${error.message}`);
            }
        }
        throw new Error(`all resolution candidates failed: ${failures.join('; ')}`);
    }

    _imageDimensions(bytes) {
        const loader = new GdkPixbuf.PixbufLoader();
        try {
            loader.write(bytes);
            loader.close();
            const pixbuf = loader.get_pixbuf();
            if (!pixbuf)
                throw new Error('image decoder returned no image');
            return [pixbuf.get_width(), pixbuf.get_height()];
        } finally {
            try {
                loader.close();
            } catch (_error) {
                // The successful path already closed the loader.
            }
        }
    }

    async _applyWallpaper(imageFile, metadata, cancellable) {
        if (cancellable.is_cancelled())
            throw new Error('refresh was cancelled');

        const uri = imageFile.get_uri();
        const settings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.background',
        });
        if (!settings.set_string('picture-uri', uri) ||
            !settings.set_string('picture-uri-dark', uri))
            throw new Error('GNOME rejected the wallpaper setting');
        Gio.Settings.sync();
        if (settings.get_string('picture-uri') !== uri ||
            settings.get_string('picture-uri-dark') !== uri)
            throw new Error('GNOME did not apply both wallpaper settings');

        const state = {
            image: imageFile.get_path(),
            updated_at: nowIso8601(),
        };
        const metadataFile = this._output.get_child(
            `${imageFile.get_basename()}.json`
        );
        if (metadataFile.query_exists(cancellable))
            state.metadata = metadataFile.get_path();
        for (const field of ['title', 'description', 'copyright', 'location', 'url']) {
            if (validText(metadata?.[field]))
                state[field] = metadata[field].trim();
        }

        await replaceContents(
            this._stateFile,
            new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`),
            cancellable
        );
        GLib.chmod(this._stateFile.get_path(), 0o600);
    }
}
