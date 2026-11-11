"use strict";

const $ = id => document.getElementById(id);
const storageKey = "isolate.library.v1";
const history = "history";
const watched = "watched";
const shell = $("player-shell");
const media = $("media");
const editor = $("editor");

let state = { folders: [], videos: [] };
let collection = history;
let current = null;
let playback = null;
let youtubeAPI;
let floatingWindow;
let floatingHost;
let changingWindow = false;
let edit = null;
let storageError = false;
const requestedTitles = new Set();

function showStatus(message = "") {
    $("status").textContent = message || (storageError ? "O navegador não permitiu salvar a biblioteca neste dispositivo." : "");
    $("status").hidden = !$("status").textContent;
}

try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved?.folders) && Array.isArray(saved?.videos)) state = saved;
} catch {
    storageError = true;
    showStatus();
}

function persist() {
    try {
        localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
        storageError = true;
        showStatus();
    }
}

function parseSource(input) {
    const raw = input.trim();
    const validID = /^[A-Za-z0-9_-]{11}$/;
    const youtube = id => ({
        key: "youtube:" + id, type: "youtube", id,
        url: "https://www.youtube.com/watch?v=" + id,
        title: "YouTube · " + id,
    });
    if (validID.test(raw)) return youtube(raw);

    const candidate = /^(?:(?:www|m|music)\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be)\//i.test(raw)
        ? "https://" + raw : raw;
    let url;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;

    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (host === "youtu.be" || host === "www.youtu.be") {
        return validID.test(first ?? "") ? youtube(first) : null;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" || host === "www.youtube-nocookie.com") {
        const id = first === "watch" ? url.searchParams.get("v") :
            ["shorts", "embed", "live", "v"].includes(first) ? second : null;
        return validID.test(id ?? "") ? youtube(id) : null;
    }

    // Other HTTP URLs are passed to the native player, including signed media URLs.
    let title = url.pathname.split("/").filter(Boolean).at(-1) || host;
    try { title = decodeURIComponent(title); } catch { /* Keep the encoded filename. */ }
    return { key: "direct:" + url.href, type: "direct", url: url.href, title };
}

function needsYouTubeTitle(source) {
    return source?.type === "youtube" && !source.customTitle && source.title === "YouTube · " + source.id;
}

async function fetchYouTubeTitle(source) {
    if (!needsYouTubeTitle(source) || requestedTitles.has(source.key)) return;
    const { key, url } = source;
    requestedTitles.add(key);
    try {
        const endpoint = new URL("https://www.youtube.com/oembed");
        endpoint.search = new URLSearchParams({ url, format: "json" });
        const response = await fetch(endpoint);
        if (!response.ok) return;
        const data = await response.json();
        const title = typeof data.title === "string" ? data.title.trim() : "";
        if (!title) return;

        const saved = findVideo(key);
        if (needsYouTubeTitle(saved)) {
            saved.title = title;
            persist();
        }
        if (current?.key === key && needsYouTubeTitle(current)) current.title = title;
        if (saved || current?.key === key) render();
    } catch { /* Keep the existing label if metadata is unavailable. */ }
}

function findVideo(key) {
    return state.videos.find(video => video.key === key);
}

function ensureVideo(source) {
    const existing = findVideo(source.key);
    if (existing) return existing;
    const video = { ...source, folderId: null, watched: false, lastPlayed: 0, addedAt: Date.now() };
    state.videos.push(video);
    return video;
}

function videosIn(id) {
    if (id === history) return state.videos.filter(video => video.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed);
    if (id === watched) return state.videos.filter(video => video.watched).sort((a, b) => b.lastPlayed - a.lastPlayed);
    return state.videos.filter(video => video.folderId === id).sort((a, b) => b.addedAt - a.addedAt);
}

function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
}

function icon(name, className = "") {
    const node = element("span", "icon " + className, name);
    node.setAttribute("aria-hidden", "true");
    return node;
}

function action(name, label, handler) {
    const button = element("button", "icon-button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(name));
    button.addEventListener("click", handler);
    return button;
}

function collectionButton(id, label, symbol) {
    const button = element("button", "collection");
    button.type = "button";
    if (id === collection) button.setAttribute("aria-current", "true");
    button.append(icon(symbol), element("span", "collection-label", label),
        element("span", "count", videosIn(id).length));
    button.addEventListener("click", () => {
        collection = id;
        if (collapsedPlaylists.delete(id)) savePreferences();
        render();
        const container = id === history || id === watched ? $("collections") : $("folders");
        container.querySelector('[aria-current="true"]')?.focus();
    });
    return button;
}

function playlistTree(excludedId, hideCollapsed = false) {
    const children = new Map();
    for (const folder of state.folders) {
        if (folder.id === excludedId) continue;
        const parentId = folder.parentId ?? null;
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(folder);
    }

    const playlists = [];
    const pending = [];
    function queueChildren(parentId, prefix, depth) {
        const siblings = children.get(parentId) ?? [];
        for (let index = siblings.length - 1; index >= 0; index--) {
            const folder = siblings[index];
            pending.push({ folder, depth, path: prefix + folder.name });
        }
    }

    queueChildren(null, "", 0);
    while (pending.length) {
        const item = pending.pop();
        playlists.push(item);
        if (!hideCollapsed || !collapsedPlaylists.has(item.folder.id)) {
            queueChildren(item.folder.id, item.path + " / ", item.depth + 1);
        }
    }
    return playlists;
}
function expandPlaylistPath(id) {
    while (id) {
        collapsedPlaylists.delete(id);
        id = state.folders.find(folder => folder.id === id)?.parentId;
    }
}

function togglePlaylist(id) {
    if (collapsedPlaylists.has(id)) {
        collapsedPlaylists.delete(id);
        collection = id;
    } else {
        collapsedPlaylists.add(id);
        if (collection !== history && collection !== watched &&
            !playlistTree(undefined, true).some(item => item.folder.id === collection)) {
            collection = id;
        }
    }
    savePreferences();
    render();
    document.getElementById("playlist-toggle-" + id)?.focus();
}

function playlistSelect(emptyLabel, excludedId) {
    const select = element("select");
    select.add(new Option(emptyLabel, ""));
    for (const { folder, path } of playlistTree(excludedId)) {
        select.add(new Option(path, folder.id));
    }
    return select;
}

const titleTooltip = $("video-title-tooltip");

function hideTitleTooltip() {
    titleTooltip.hidden = true;
}

function showTitleTooltip(title, x, y) {
    if (titleTooltip.hidden || titleTooltip.textContent !== title) {
        titleTooltip.textContent = title;
        titleTooltip.hidden = false;
    }
    const margin = 8;
    const width = titleTooltip.offsetWidth;
    const height = titleTooltip.offsetHeight;
    const left = Math.max(margin, Math.min(x - width / 2, document.documentElement.clientWidth - width - margin));
    const above = y - height - 12;
    const top = above >= margin ? above : Math.max(margin, Math.min(y + 14, window.innerHeight - height - margin));
    Object.assign(titleTooltip.style, { left: left + "px", top: top + "px" });
}

function attachTitleTooltip(button, title) {
    const followPointer = event => {
        if (event.pointerType !== "touch") showTitleTooltip(title, event.clientX, event.clientY);
    };
    button.addEventListener("pointerenter", followPointer);
    button.addEventListener("pointermove", followPointer);
    button.addEventListener("pointerleave", hideTitleTooltip);
    button.addEventListener("blur", hideTitleTooltip);
    button.addEventListener("focus", () => {
        if (!button.matches(":focus-visible")) return;
        const rect = button.getBoundingClientRect();
        showTitleTooltip(title, rect.left + rect.width / 2, rect.top);
    });
}

function render() {
    hideTitleTooltip();
    const folder = state.folders.find(item => item.id === collection);
    $("collections").replaceChildren(collectionButton(history, "Histórico", "history"),
        collectionButton(watched, "Assistidos", "check_circle"));
    $("folders").replaceChildren(...playlistTree(undefined, true).map(({ folder: item, path, depth }) => {
        const row = element("div", "playlist-row");
        const button = collectionButton(item.id, item.name, depth ? "folder_open" : "folder");
        button.title = path;
        row.style.setProperty("--playlist-indent", Math.min(depth, 5) * 8 + "px");
        const expanded = !collapsedPlaylists.has(item.id);
        const toggle = action(expanded ? "expand_more" : "chevron_right",
            (expanded ? "Recolher " : "Expandir ") + path, () => togglePlaylist(item.id));
        toggle.id = "playlist-toggle-" + item.id;
        toggle.classList.add("playlist-toggle");
        toggle.setAttribute("aria-expanded", String(expanded));
        row.append(toggle, button,
            action("add", "Criar subpasta em " + path, () => editFolder(null, item)),
            action("more_vert", "Editar ou excluir " + path, () => editFolder(item)));
        return row;
    }));
    $("list-title").textContent = folder?.name ?? (collection === watched ? "Assistidos" : "Histórico");
    $("add-playlist-video").hidden = !folder;

    const entriesPanel = $("entries");
    entriesPanel.hidden = Boolean(folder && collapsedPlaylists.has(folder.id));
    const visibleVideos = entriesPanel.hidden ? [] : videosIn(collection);
    const entries = visibleVideos.map(video => {
        fetchYouTubeTitle(video);
        const row = element("div", "entry" + (video.key === current?.key ? " current" : ""));
        const play = element("button", "entry-play");
        play.type = "button";
        const title = element("span", "entry-title", video.title);
        const status = element("small", "", video.watched ? "Assistido" : video.type === "youtube" ? "YouTube" : "Vídeo direto");
        const preview = element("span", "entry-preview");
        preview.append(icon(video.watched ? "check_circle" : "play_circle", video.watched ? "watched" : ""));
        if (video.type === "youtube") {
            const thumbnail = element("img");
            thumbnail.alt = "";
            thumbnail.loading = "lazy";
            thumbnail.draggable = false;
            thumbnail.addEventListener("error", () => thumbnail.remove(), { once: true });
            thumbnail.src = "https://i.ytimg.com/vi/" + encodeURIComponent(video.id) + "/mqdefault.jpg";
            preview.append(thumbnail);
        }
        play.append(preview, title, status);
        attachTitleTooltip(play, video.title);
        play.addEventListener("click", () => {
            loadVideo(video);
        });
        row.append(play, action("more_vert", "Gerenciar " + video.title, () => editVideo(video)));
        return row;
    });
    entriesPanel.replaceChildren(...(entries.length || entriesPanel.hidden ? entries : [
        element("p", "list-empty", folder ? "Nenhum vídeo nesta playlist." :
            collection === watched ? "Nenhum vídeo marcado como assistido." : "Os vídeos reproduzidos aparecem aqui."),
    ]));

    const video = current && findVideo(current.key);
    $("now-playing").textContent = video?.title ?? current?.title ?? "Reprodutor";
    $("save-video").disabled = !current;
    $("watch-video").disabled = !current;
    const watchLabel = video?.watched ? "Marcar como não assistido" : "Marcar como assistido";
    $("watch-video").setAttribute("aria-pressed", String(Boolean(video?.watched)));
    $("watch-video").setAttribute("aria-label", watchLabel);
    $("watch-video").title = watchLabel;
    $("pip").disabled = !current;
}

function setWatched(source, value, feedback = true) {
    const video = ensureVideo(source);
    if (feedback && value && !video.watched) playSound("complete");
    video.watched = value;
    persist();
    render();
}

function recordPlay(source) {
    const video = ensureVideo(source);
    video.lastPlayed = Date.now();
    persist();
    render();
}

function openEditor(config) {
    hideTitleTooltip();
    edit = config;
    $("editor-title").textContent = config.title;
    $("editor-fields").replaceChildren(...config.fields);
    $("editor-error").hidden = true;
    $("delete-item").hidden = !config.remove;
    $("delete-item").textContent = "Excluir";
    $("commit-edit").textContent = "Salvar";
    editor.showModal();
    $("editor-fields").querySelector("input, select")?.focus();
}

function field(label, input) {
    const wrapper = element("label", "", label);
    wrapper.append(input);
    return wrapper;
}

function textInput(value, maxLength) {
    const input = element("input");
    input.required = true;
    input.maxLength = maxLength;
    input.defaultValue = value;
    return input;
}

function hasPlaylistName(name, parentId, excludedId) {
    const normalized = name.toLocaleLowerCase("pt-BR");
    return state.folders.some(item => item.id !== excludedId &&
        (item.parentId ?? null) === parentId && item.name.toLocaleLowerCase("pt-BR") === normalized);
}

function editFolder(folder, parentFolder = null) {
    const name = textInput(folder?.name ?? "", 60);
    const parent = folder ? playlistSelect("Nível principal", folder.id) : null;
    const fields = [field("Nome da playlist", name)];
    if (parent) {
        parent.value = folder.parentId ?? "";
        fields.push(field("Playlist superior", parent));
    }
    const hasChildren = folder && state.folders.some(item => item.parentId === folder.id);
    openEditor({
        title: folder ? "Editar playlist" : parentFolder ? "Nova subpasta em " + parentFolder.name : "Nova playlist",
        fields,
        save() {
            const value = name.value.trim();
            if (!value) return "Digite um nome para a playlist.";
            const parentId = parent ? (parent.value || null) : (parentFolder?.id ?? null);
            if (hasPlaylistName(value, parentId, folder?.id)) {
                return "Já existe uma playlist com esse nome neste nível.";
            }
            expandPlaylistPath(parentId);
            if (folder) {
                Object.assign(folder, { name: value, parentId });
            } else {
                const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());
                state.folders.push({ id, name: value, parentId });
                collection = id;
                preferences.playlistsCollapsed = false;
                renderPlaylistTray();
            }
            savePreferences();
        },
        remove: folder && (() => {
            state.folders = state.folders.filter(item => item.id !== folder.id);
            collapsedPlaylists.delete(folder.id);
            savePreferences();
            const parentId = folder.parentId ?? null;
            for (const child of state.folders.filter(item => item.parentId === folder.id)) {
                let name = child.name;
                for (let number = 2; hasPlaylistName(name, parentId, child.id); number++) {
                    const suffix = " (" + number + ")";
                    name = child.name.slice(0, 60 - suffix.length) + suffix;
                }
                Object.assign(child, { name, parentId });
            }
            for (const video of state.videos) {
                if (video.folderId === folder.id) video.folderId = null;
            }
            state.videos = state.videos.filter(video => video.folderId || video.lastPlayed || video.watched);
            collection = parentId ?? history;
        }),
        confirm: "Excluir esta playlist? Os vídeos do histórico e dos assistidos continuam nessas listas." +
            (hasChildren ? " As subpastas sobem um nível." : ""),
    });
}

function addVideoToPlaylist(folder) {
    const link = textInput("", 4096);
    link.classList.add("editable-link");
    link.inputMode = "url";
    link.autocomplete = "off";
    openEditor({
        title: "Adicionar vídeo em " + folder.name,
        fields: [field("Link ou ID do YouTube", link)],
        save() {
            const source = parseSource(link.value);
            if (!source) return "Insira um link direto de vídeo ou um link ou ID do YouTube.";
            const existing = findVideo(source.key);
            if (existing?.folderId === folder.id) return "Este vídeo já está nesta playlist.";
            if (existing?.folderId) {
                return "Este vídeo está em outra playlist. Use o menu do vídeo para movê-lo.";
            }

            const video = existing ?? ensureVideo(source);
            video.folderId = folder.id;
            if (collapsedPlaylists.delete(folder.id)) savePreferences();
        },
    });
}

$("add-playlist-video").addEventListener("click", () => {
    const folder = state.folders.find(item => item.id === collection);
    if (folder) addVideoToPlaylist(folder);
});

function editVideo(source) {
    const video = findVideo(source.key);
    const title = textInput(video?.title ?? source.title, 180);
    const link = textInput(video?.url ?? source.url, 4096);
    link.classList.add("editable-link");
    const folder = playlistSelect("Nenhuma playlist");
    folder.value = video?.folderId ?? (state.folders.some(item => item.id === collection) ? collection : "");
    const inFolder = Boolean(video?.folderId && video.folderId === collection);
    const check = element("input");
    check.type = "checkbox";
    check.checked = Boolean(video?.watched);
    openEditor({
        title: video ? "Gerenciar vídeo" : "Salvar vídeo",
        fields: [field("Título", title), field("Link ou ID", link), field("Playlist", folder), field("Assistido", check)],
        save() {
            const updated = parseSource(link.value);
            if (!updated) return "Insira um link de vídeo válido ou um ID do YouTube.";
            if (!title.value.trim()) return "Digite um título para o vídeo.";
            const duplicate = findVideo(updated.key);
            if (duplicate && duplicate !== video) return "Esse vídeo já está na biblioteca.";
            if (!video && !folder.value && !check.checked) return "Escolha uma playlist ou marque o vídeo como assistido.";
            const record = video ?? ensureVideo(updated);
            const sameSource = record.key === updated.key;
            const enteredTitle = title.value.trim();
            const titleChanged = enteredTitle !== title.defaultValue;
            const customTitle = titleChanged || Boolean(sameSource && record.customTitle);
            const savedTitle = titleChanged ? enteredTitle : source.key === updated.key ? (video?.title ?? source.title) : updated.title;
            Object.assign(record, updated, {
                title: savedTitle, customTitle, folderId: folder.value || null, watched: check.checked,
            });
            if (!sameSource) {
                record.lastPlayed = 0;
                if (current?.key === source.key) loadVideo(record);
            }
            if (!record.folderId && !record.watched && !record.lastPlayed) {
                state.videos = state.videos.filter(item => item !== record);
            }
        },
        remove: video && (() => {
            if (inFolder && (video.lastPlayed || video.watched)) video.folderId = null;
            else state.videos = state.videos.filter(item => item !== video);
        }),
        confirm: inFolder ? "Remover este vídeo da playlist?" : "Excluir este vídeo da biblioteca?",
    });
}

$("editor-form").addEventListener("submit", event => {
    event.preventDefault();
    const error = edit.save();
    if (error) {
        $("editor-error").textContent = error;
        $("editor-error").hidden = false;
        return;
    }
    editor.close();
    playSound("confirm");
    persist();
    render();
});

$("delete-item").addEventListener("click", () => {
    if ($("delete-item").textContent !== "Confirmar exclusão") {
        $("editor-error").textContent = edit.confirm;
        $("editor-error").hidden = false;
        $("delete-item").textContent = "Confirmar exclusão";
        return;
    }
    edit.remove();
    editor.close();
    playSound("confirm");
    persist();
    render();
});
$("cancel-edit").addEventListener("click", () => editor.close());
$("new-folder").addEventListener("click", () => editFolder());

const library = $("library");
library.addEventListener("scroll", hideTitleTooltip, { passive: true });
window.addEventListener("resize", hideTitleTooltip);
const libraryToggle = $("library-toggle");
const libraryResize = $("library-resize");
const themeColor = $("theme-color");
const retroSounds = $("retro-sounds");
const startRate = $("start-rate");
const playlistsToggle = $("playlists-toggle");
const preferencesKey = "isolate.preferences.v1";
const defaultPreferences = { color: "#ff525d", libraryWidth: 288, sound: false, rate: 1, playlistsCollapsed: false };
const validColor = /^#[0-9a-f]{6}$/i;
let preferences = { ...defaultPreferences };
const collapsedPlaylists = new Set();

try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey));
    if (validColor.test(saved?.color)) preferences.color = saved.color;
    if (Number.isFinite(saved?.libraryWidth)) preferences.libraryWidth = saved.libraryWidth;
    if (saved?.sound === true) preferences.sound = true;
    if ([...startRate.options].some(option => Number(option.value) === saved?.rate)) preferences.rate = saved.rate;
    if (saved?.playlistsCollapsed === true) preferences.playlistsCollapsed = true;
    if (Array.isArray(saved?.collapsedPlaylists)) {
        for (const id of saved.collapsedPlaylists) {
            if (typeof id === "string") collapsedPlaylists.add(id);
        }
    }
} catch { /* Use defaults when preferences are unavailable. */ }

function savePreferences() {
    try {
        localStorage.setItem(preferencesKey, JSON.stringify({ ...preferences, collapsedPlaylists: [...collapsedPlaylists] }));
    } catch { /* Preferences still apply to the current page. */ }
}

function applyTheme(color) {
    const channels = color.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
    const [red, green, blue] = channels.map(channel =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const root = document.documentElement;
    root.style.setProperty("--accent", color);
    root.style.setProperty("--accent-ink", luminance > 0.179 ? "#000000" : "#ffffff");
    root.style.setProperty("--accent-hover", luminance > 0.179 ?
        "color-mix(in srgb, var(--accent) 80%, white)" : "color-mix(in srgb, var(--accent) 80%, black)");
    themeColor.value = color;
}

themeColor.addEventListener("input", () => applyTheme(themeColor.value));
themeColor.addEventListener("change", () => {
    preferences.color = themeColor.value;
    savePreferences();
});
applyTheme(preferences.color);
startRate.value = String(preferences.rate);
startRate.addEventListener("change", () => {
    preferences.rate = Number(startRate.value);
    savePreferences();
});

function setLibraryTab(settings) {
    hideTitleTooltip();
    $("settings").hidden = !settings;
    $("library-videos").hidden = settings;
    $("settings-tab").setAttribute("aria-pressed", String(settings));
    $("videos-tab").setAttribute("aria-pressed", String(!settings));
}
$("settings-tab").addEventListener("click", () => setLibraryTab(true));
$("videos-tab").addEventListener("click", () => setLibraryTab(false));

function renderPlaylistTray() {
    $("folders").hidden = preferences.playlistsCollapsed;
    playlistsToggle.setAttribute("aria-expanded", String(!preferences.playlistsCollapsed));
}
playlistsToggle.addEventListener("click", () => {
    preferences.playlistsCollapsed = !preferences.playlistsCollapsed;
    renderPlaylistTray();
    savePreferences();
});
renderPlaylistTray();

function setLibraryOpen(open, focusControl = false) {
    if (!open) hideTitleTooltip();
    library.hidden = !open;
    const label = open ? "Fechar menu" : "Abrir menu";
    libraryToggle.setAttribute("aria-expanded", String(open));
    libraryToggle.setAttribute("aria-label", label);
    libraryToggle.title = label;
    if (focusControl) (open ? $("library-close") : libraryToggle).focus();
    revealControls();
}

libraryToggle.addEventListener("click", () => setLibraryOpen(library.hidden, true));
$("library-close").addEventListener("click", () => setLibraryOpen(false, true));
library.addEventListener("keydown", event => {
    if (event.key === "Escape") setLibraryOpen(false, true);
});

function setLibraryWidth(width) {
    const max = Math.min(660, document.documentElement.clientWidth - 28);
    const min = Math.min(230, max);
    const next = Math.round(Math.max(min, Math.min(max, width)));
    library.style.setProperty("--library-width", next + "px");
    libraryResize.setAttribute("aria-valuemin", String(min));
    libraryResize.setAttribute("aria-valuemax", String(max));
    libraryResize.setAttribute("aria-valuenow", String(next));
    return next;
}

function resizeLibrary(width) {
    const previous = libraryResize.getAttribute("aria-valuenow");
    preferences.libraryWidth = setLibraryWidth(width);
    if (String(preferences.libraryWidth) !== previous) playResizeSound("libraryResize");
}

let libraryDrag;
libraryResize.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    libraryDrag = {
        pointer: event.pointerId,
        x: event.clientX,
        width: library.getBoundingClientRect().width,
    };
    libraryResize.setPointerCapture(event.pointerId);
    libraryResize.classList.add("resizing");
});

libraryResize.addEventListener("pointermove", event => {
    if (event.pointerId !== libraryDrag?.pointer) return;
    resizeLibrary(libraryDrag.width + event.clientX - libraryDrag.x);
});

libraryResize.addEventListener("lostpointercapture", () => {
    libraryDrag = null;
    libraryResize.classList.remove("resizing");
    savePreferences();
});

libraryResize.addEventListener("keydown", event => {
    const width = Number(libraryResize.getAttribute("aria-valuenow"));
    const step = event.shiftKey ? 48 : 16;
    const target = { ArrowLeft: width - step, ArrowRight: width + step, Home: 0, End: 660 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    resizeLibrary(target);
    savePreferences();
});
window.addEventListener("resize", () => setLibraryWidth(preferences.libraryWidth));
setLibraryWidth(preferences.libraryWidth);

const soundPatterns = {
    click: [440, 660],
    screenClick: [520, 390],
    videoResize: [620, 820],
    libraryResize: [285, 365],
    confirm: [392, 523, 784],
    close: [440, 330],
    complete: [523, 659, 784, 1047],
    playbackStart: [392, 523, 659, [784, 0.16]],
    playbackPause: [659, [392, 0.09]],
    playbackVictory: [523, 523, 523, 659, 784, 659, 784, [1047, 0.32]],
};
let audioContext;
const lastResizeSound = new Map();

function playResizeSound(name) {
    const now = performance.now();
    if (now - (lastResizeSound.get(name) ?? -Infinity) < 100) return;
    lastResizeSound.set(name, now);
    playSound(name);
}

async function unlockSound() {
    if (!preferences.sound || !window.AudioContext) return;
    audioContext ??= new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
}

async function playSound(name) {
    if (!preferences.sound || !window.AudioContext) return;
    try {
        await unlockSound();
        if (!preferences.sound || audioContext.state !== "running") return;
        let time = audioContext.currentTime;
        for (const pitch of soundPatterns[name]) {
            const [frequency, duration] = Array.isArray(pitch) ? pitch : [pitch, 0.065];
            const note = audioContext.createOscillator();
            const envelope = audioContext.createGain();
            note.type = "square";
            note.frequency.value = frequency;
            envelope.gain.setValueAtTime(0.001, time);
            envelope.gain.exponentialRampToValueAtTime(0.025, time + 0.008);
            envelope.gain.exponentialRampToValueAtTime(0.001, time + duration - 0.005);
            note.connect(envelope).connect(audioContext.destination);
            note.start(time);
            note.stop(time + duration);
            time += duration;
        }
    } catch { /* Audio feedback is optional. */ }
}

retroSounds.checked = preferences.sound;
retroSounds.addEventListener("change", () => {
    preferences.sound = retroSounds.checked;
    savePreferences();
    playSound("confirm");
});

document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (event.target.closest("#library-resize")) return;
    if (!button) {
        playSound("screenClick");
        return;
    }
    if (button.disabled) return;
    const quiet = ["drag-player", "resize-player", "commit-edit"];
    if (quiet.includes(button.id)) return;
    playSound(["library-close", "cancel-edit", "dock-player"].includes(button.id) ? "close" : "click");
});

let isPlaying = false;
let idleTimer;

function revealControls() {
    document.body.classList.remove("controls-idle");
    clearTimeout(idleTimer);
    if (!isPlaying) return;
    idleTimer = setTimeout(() => {
        const focused = document.activeElement;
        if (editor.open || focused === $("video-link") ||
            (focused instanceof HTMLElement && focused.matches("button:focus-visible, select:focus-visible, input:focus-visible, [role=separator]:focus-visible")) ||
            shell.classList.contains("adjusting") || libraryDrag) return;
        document.body.classList.add("controls-idle");
    }, 2000);
}

function setPlaying(value) {
    isPlaying = value;
    if (value) document.body.classList.add("focus-player");
    revealControls();
}

document.addEventListener("pointermove", revealControls, { passive: true });
document.addEventListener("pointerdown", revealControls, { passive: true });
document.addEventListener("keydown", revealControls);
document.addEventListener("focusin", revealControls);
document.addEventListener("focusout", revealControls);
document.addEventListener("fullscreenchange", revealControls);
editor.addEventListener("close", revealControls);

function loadYouTubeAPI() {
    if (window.YT?.Player) return Promise.resolve();
    if (youtubeAPI) return youtubeAPI;
    youtubeAPI = new Promise((resolve, reject) => {
        const script = element("script");
        const timer = setTimeout(fail, 12000);
        function fail() {
            clearTimeout(timer);
            script.remove();
            youtubeAPI = null;
            reject(new Error("YouTube indisponível"));
        }
        window.onYouTubeIframeAPIReady = () => {
            clearTimeout(timer);
            resolve();
        };
        script.src = "https://www.youtube.com/iframe_api";
        script.onerror = fail;
        document.head.append(script);
    });
    return youtubeAPI;
}

function mediaError(message, active, url = active.source.url, label = "Abrir na origem") {
    if (playback !== active) return;
    setPlaying(false);
    $("media-error-text").textContent = message;
    $("open-source").href = url;
    $("open-source-label").textContent = label;
    $("media-error").hidden = false;
}

function stopPlayback() {
    setPlaying(false);
    if (!playback) return;
    const previous = playback;
    playback = null;
    previous.controller?.destroy();
    previous.node?.pause?.();
    previous.node?.remove();
    previous.host.replaceChildren();
}

function markPlaying(active) {
    if (playback !== active) return;
    if (active.phase !== "playing") playSound("playbackStart");
    active.phase = "playing";
    setPlaying(active.host === media);
    if (active.recorded) return;
    active.recorded = true;
    recordPlay(active.source);
}

function markPaused(active) {
    if (playback !== active || active.phase !== "playing") return;
    active.phase = "paused";
    setPlaying(false);
    playSound("playbackPause");
}

function markEnded(active) {
    if (playback !== active || active.phase === "ended") return;
    active.phase = "ended";
    setPlaying(false);
    setWatched(active.source, true, false);
    playSound("playbackVictory");
}

async function mountPlayback(source, host, position = 0, autoplay = true, recorded = false, rate = preferences.rate, continuing = false) {
    stopPlayback();
    const active = { source, host, recorded, position, autoplay, rate, phase: continuing ? "playing" : "pending" };
    playback = active;
    const doc = host.ownerDocument;

    if (source.type === "direct") {
        const video = doc.createElement("video");
        active.node = video;
        video.controls = true;
        video.playsInline = true;
        video.draggable = false;
        video.defaultPlaybackRate = rate;
        video.playbackRate = rate;
        video.autoplay = autoplay;
        video.src = source.url;
        video.addEventListener("loadedmetadata", () => {
            if (position && position < video.duration) video.currentTime = position;
        }, { once: true });
        video.addEventListener("playing", () => markPlaying(active));
        video.addEventListener("pause", () => {
            if (!video.ended) markPaused(active);
        });
        video.addEventListener("ended", () => markEnded(active));
        video.addEventListener("error", () => mediaError(
            "Não foi possível reproduzir. Use um link direto para um arquivo de vídeo compatível.", active));
        host.append(video);
        return;
    }

    if (!["http:", "https:"].includes(location.protocol)) {
        mediaError("Abra o Isolate no GitHub Pages para reproduzir vídeos do YouTube.", active,
            "https://carlossssz.github.io/Isolate-Video/", "Abrir Isolate no GitHub Pages");
        return;
    }

    try {
        await loadYouTubeAPI();
        if (playback !== active) return;
        const iframe = doc.createElement("iframe");
        active.node = iframe;
        const url = new URL("https://www.youtube.com/embed/" + source.id);
        url.search = new URLSearchParams({
            enablejsapi: "1", origin: location.origin, playsinline: "1", rel: "0",
            autoplay: autoplay ? "1" : "0", start: String(Math.floor(position)),
        });
        iframe.title = findVideo(source.key)?.title ?? source.title;
        iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
        iframe.allowFullscreen = true;
        iframe.draggable = false;
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
        iframe.src = url.href;
        host.append(iframe);
        active.controller = new YT.Player(iframe, {
            events: {
                onReady(event) {
                    if (playback !== active) return;
                    active.ready = true;
                    event.target.setPlaybackRate(rate);
                    if (autoplay) event.target.playVideo();
                },
                onAutoplayBlocked() {
                    if (playback === active) showStatus(host === media ?
                        "Clique em Reproduzir no vídeo para iniciar." :
                        "Clique em Reproduzir no vídeo dentro da janela flutuante para continuar.");
                },
                onStateChange(event) {
                    if (playback !== active) return;
                    if (event.data === YT.PlayerState.PLAYING) markPlaying(active);
                    if (event.data === YT.PlayerState.PAUSED) markPaused(active);
                    if (event.data === YT.PlayerState.ENDED) markEnded(active);
                },
                onError(event) {
                    const message = event.data === 153 ?
                        "Erro 153: o YouTube não recebeu a identificação da página. Se estiver em uma prévia, abra o site publicado em uma aba do navegador." :
                        "O YouTube não conseguiu reproduzir este vídeo no player incorporado.";
                    mediaError(message, active);
                },
            },
        });
    } catch {
        mediaError("Não foi possível carregar o player do YouTube.", active);
    }
}

function loadVideo(source) {
    unlockSound().catch(() => {});
    setLibraryOpen(false);
    $("video-link").blur();
    dockPlayer();
    current = { ...(findVideo(source.key) ?? source) };
    fetchYouTubeTitle(current);
    $("video-link").value = source.url;
    $("empty-player").hidden = true;
    $("media-error").hidden = true;
    showStatus();
    mountPlayback(current, floatingHost ?? media);
    render();
}

$("load-form").addEventListener("submit", event => {
    event.preventDefault();
    const source = parseSource($("video-link").value);
    if (!source) {
        showStatus("Cole um link válido ou um ID do YouTube com 11 caracteres.");
        $("video-link").focus();
        return;
    }
    loadVideo(source);
});
$("save-video").addEventListener("click", () => editVideo(current));
$("watch-video").addEventListener("click", () => setWatched(current, !findVideo(current.key)?.watched));

function playbackState() {
    const active = playback;
    if (!active) return {};
    if (active.source.type === "direct") {
        return { position: active.node.currentTime, autoplay: !active.node.paused, recorded: active.recorded, rate: active.node.playbackRate };
    }
    if (!active.ready) return active;
    return {
        position: active.controller.getCurrentTime() || 0,
        autoplay: [YT.PlayerState.PLAYING, YT.PlayerState.BUFFERING].includes(active.controller.getPlayerState()),
        recorded: active.recorded,
        rate: active.controller.getPlaybackRate() || active.rate,
    };
}

function transferPlayback(host) {
    const { position, autoplay, recorded, rate } = playbackState();
    const continuing = autoplay && playback?.phase === "playing";
    mountPlayback(current, host, position, autoplay, recorded, rate, continuing);
}

$("pip").addEventListener("click", async () => {
    if (!current || changingWindow) return;
    if (floatingWindow) {
        floatingWindow.close();
        return;
    }
    changingWindow = true;
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else if (playback?.source.type === "direct" && document.pictureInPictureEnabled &&
            playback.node?.requestPictureInPicture && playback.node.readyState >= 1) {
            await playback.node.requestPictureInPicture();
        } else if (window.documentPictureInPicture) {
            const windowPip = await window.documentPictureInPicture.requestWindow({ width: 520, height: 320 });
            floatingWindow = windowPip;
            const doc = windowPip.document;
            doc.title = "Isolate";
            doc.body.style.cssText = "margin:0;background:#090b11";
            const frame = doc.createElement("iframe");
            frame.title = "Vídeo na janela flutuante";
            frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
            frame.style.cssText = "display:block;width:100vw;height:100vh;border:0";
            // A página HTTP dá ao iframe do YouTube uma origem de referência na janela about:blank.
            frame.src = new URL("pip.html", document.baseURI).href;
            frame.addEventListener("load", () => {
                if (floatingWindow !== windowPip) return;
                const host = frame.contentDocument?.querySelector("main");
                if (host) {
                    floatingHost = host;
                    transferPlayback(host);
                    showStatus("O vídeo está na janela flutuante.");
                } else {
                    windowPip.close();
                    showStatus("Não foi possível carregar a página da janela flutuante.");
                }
            }, { once: true });
            windowPip.addEventListener("pagehide", () => {
                floatingWindow = null;
                floatingHost = null;
                if (playback && playback.host !== media) transferPlayback(media);
                showStatus();
            }, { once: true });
            doc.body.append(frame);

        } else {
            showStatus("Este navegador não oferece janela flutuante para este vídeo. Para o YouTube, use um navegador com Document Picture-in-Picture.");
        }
    } catch {
        showStatus("Não foi possível abrir a janela flutuante. Inicie a reprodução e tente novamente.");
    } finally {
        changingWindow = false;
    }
});

$("fullscreen").addEventListener("click", async () => {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await shell.requestFullscreen();
    } catch {
        showStatus("O navegador não conseguiu abrir o player em tela cheia.");
    }
});

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const viewport = () => ({ width: document.documentElement.clientWidth, height: window.innerHeight });

function positionPlayer(x, y, width, height) {
    const view = viewport();
    width = clamp(width, Math.min(290, view.width), view.width);
    height = clamp(height, Math.min(220, view.height), view.height);
    x = clamp(x, 0, view.width - width);
    y = clamp(y, 0, view.height - height);
    shell.classList.add("floating");
    Object.assign(shell.style, { left: x + "px", top: y + "px", width: width + "px", height: height + "px" });
    $("dock-player").hidden = false;
}

function dockPlayer() {
    shell.classList.remove("floating");
    shell.removeAttribute("style");
    $("dock-player").hidden = true;
}

function setupHandle(handle, resize) {
    function apply(rect, dx, dy) {
        if (resize) {
            const view = viewport();
            const width = clamp(rect.width + dx, Math.min(290, view.width), Math.max(290, view.width - rect.left));
            const height = clamp(rect.height + dy, Math.min(220, view.height), Math.max(220, view.height - rect.top));
            const previousWidth = parseFloat(shell.style.width) || rect.width;
            const previousHeight = parseFloat(shell.style.height) || rect.height;
            positionPlayer(rect.left, rect.top, width, height);
            if (Math.abs(parseFloat(shell.style.width) - previousWidth) >= 1 ||
                Math.abs(parseFloat(shell.style.height) - previousHeight) >= 1) {
                playResizeSound("videoResize");
            }
        } else {
            positionPlayer(rect.left + dx, rect.top + dy, rect.width, rect.height);
        }
    }

    let drag;
    handle.addEventListener("pointerdown", event => {
        if (!event.isPrimary || event.button !== 0 || document.fullscreenElement) return;
        drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, rect: shell.getBoundingClientRect() };
        handle.setPointerCapture(event.pointerId);
        shell.classList.add("adjusting");
    });
    handle.addEventListener("pointermove", event => {
        if (event.pointerId === drag?.pointer) apply(drag.rect, event.clientX - drag.x, event.clientY - drag.y);
    });
    handle.addEventListener("lostpointercapture", () => {
        drag = null;
        shell.classList.remove("adjusting");
        revealControls();
    });
    handle.addEventListener("keydown", event => {
        const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!directions[event.key] || document.fullscreenElement) return;
        event.preventDefault();
        const [x, y] = directions[event.key];
        const step = event.shiftKey ? 40 : 12;
        apply(shell.getBoundingClientRect(), x * step, y * step);
    });
}

setupHandle($("drag-player"), false);
setupHandle($("resize-player"), true);
$("dock-player").addEventListener("click", () => {
    dockPlayer();
    $("drag-player").focus();
});
window.addEventListener("resize", () => {
    if (!shell.classList.contains("floating") || document.fullscreenElement) return;
    const rect = shell.getBoundingClientRect();
    positionPlayer(rect.left, rect.top, rect.width, rect.height);
});
render();
