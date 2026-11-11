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
        render();
        const container = id === history || id === watched ? $("collections") : $("folders");
        container.querySelector('[aria-current="true"]')?.focus();
    });
    return button;
}

function render() {
    const folder = state.folders.find(item => item.id === collection);
    $("collections").replaceChildren(collectionButton(history, "Histórico", "history"),
        collectionButton(watched, "Assistidos", "check_circle"));
    $("folders").replaceChildren(...state.folders.map(item => collectionButton(item.id, item.name, "folder")));
    $("list-title").textContent = folder?.name ?? (collection === watched ? "Assistidos" : "Histórico");
    $("edit-folder").hidden = !folder;

    const entries = videosIn(collection).map(video => {
        const row = element("div", "entry" + (video.key === current?.key ? " current" : ""));
        const play = element("button", "entry-play");
        play.type = "button";
        const title = element("span", "entry-title", video.title);
        title.append(element("small", "", video.watched ? "Assistido" : video.type === "youtube" ? "YouTube" : "Vídeo direto"));
        play.append(icon(video.watched ? "check_circle" : "play_circle", video.watched ? "watched" : ""), title);
        play.addEventListener("click", () => {
            if (matchMedia("(max-width: 760px)").matches) setLibraryOpen(false, true);
            loadVideo(video);
        });
        row.append(play, action("more_vert", "Gerenciar " + video.title, () => editVideo(video)));
        return row;
    });
    $("entries").replaceChildren(...(entries.length ? entries : [
        element("p", "list-empty", folder ? "Nenhum vídeo nesta pasta." :
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

function setWatched(source, value) {
    const video = ensureVideo(source);
    if (value && !video.watched) playSound("complete");
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
    input.value = value;
    return input;
}

function editFolder(folder) {
    const name = textInput(folder?.name ?? "", 60);
    openEditor({
        title: folder ? "Editar pasta" : "Nova pasta",
        fields: [field("Nome da pasta", name)],
        save() {
            const value = name.value.trim();
            if (!value) return "Digite um nome para a pasta.";
            if (state.folders.some(item => item.id !== folder?.id && item.name.toLocaleLowerCase("pt-BR") === value.toLocaleLowerCase("pt-BR"))) {
                return "Já existe uma pasta com esse nome.";
            }
            if (folder) folder.name = value;
            else {
                const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());
                state.folders.push({ id, name: value });
                collection = id;
            }
        },
        remove: folder && (() => {
            state.folders = state.folders.filter(item => item.id !== folder.id);
            for (const video of state.videos) {
                if (video.folderId === folder.id) video.folderId = null;
            }
            state.videos = state.videos.filter(video => video.folderId || video.lastPlayed || video.watched);
            collection = history;
        }),
        confirm: "Excluir esta pasta? Os vídeos do histórico e dos assistidos continuam nessas listas.",
    });
}

function editVideo(source) {
    const video = findVideo(source.key);
    const title = textInput(video?.title ?? source.title, 180);
    const link = textInput(video?.url ?? source.url, 4096);
    const folder = element("select");
    folder.add(new Option("Nenhuma pasta", ""));
    for (const item of state.folders) folder.add(new Option(item.name, item.id));
    folder.value = video?.folderId ?? (state.folders.some(item => item.id === collection) ? collection : "");
    const inFolder = Boolean(video?.folderId && video.folderId === collection);
    const check = element("input");
    check.type = "checkbox";
    check.checked = Boolean(video?.watched);
    openEditor({
        title: video ? "Gerenciar vídeo" : "Salvar vídeo",
        fields: [field("Título", title), field("Link ou ID", link), field("Pasta", folder), field("Assistido", check)],
        save() {
            const updated = parseSource(link.value);
            if (!updated) return "Insira um link de vídeo válido ou um ID do YouTube.";
            if (!title.value.trim()) return "Digite um título para o vídeo.";
            const duplicate = findVideo(updated.key);
            if (duplicate && duplicate !== video) return "Esse vídeo já está na biblioteca.";
            if (!video && !folder.value && !check.checked) return "Escolha uma pasta ou marque o vídeo como assistido.";
            const record = video ?? ensureVideo(updated);
            const sameSource = record.key === updated.key;
            Object.assign(record, updated, { title: title.value.trim(), folderId: folder.value || null, watched: check.checked });
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
        confirm: inFolder ? "Remover este vídeo da pasta?" : "Excluir este vídeo da biblioteca?",
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
$("edit-folder").addEventListener("click", () => editFolder(state.folders.find(item => item.id === collection)));

const library = $("library");
const libraryToggle = $("library-toggle");
const libraryResize = $("library-resize");
const themeColor = $("theme-color");
const soundToggle = $("sound-toggle");
const preferencesKey = "isolate.preferences.v1";
const defaultPreferences = { color: "#ff525d", libraryWidth: 288, sound: false };
const validColor = /^#[0-9a-f]{6}$/i;
let preferences = { ...defaultPreferences };

try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey));
    if (validColor.test(saved?.color)) preferences.color = saved.color;
    if (Number.isFinite(saved?.libraryWidth)) preferences.libraryWidth = saved.libraryWidth;
    if (saved?.sound === true) preferences.sound = true;
} catch { /* Use defaults when preferences are unavailable. */ }

function savePreferences() {
    try {
        localStorage.setItem(preferencesKey, JSON.stringify(preferences));
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

function setLibraryOpen(open, focusControl = false) {
    library.hidden = !open;
    const label = open ? "Fechar biblioteca" : "Abrir biblioteca";
    libraryToggle.setAttribute("aria-expanded", String(open));
    libraryToggle.setAttribute("aria-label", label);
    libraryToggle.title = label;
    if (focusControl) (open ? $("library-close") : libraryToggle).focus();
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
    preferences.libraryWidth = setLibraryWidth(libraryDrag.width + event.clientX - libraryDrag.x);
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
    preferences.libraryWidth = setLibraryWidth(target);
    savePreferences();
});
window.addEventListener("resize", () => setLibraryWidth(preferences.libraryWidth));
setLibraryWidth(preferences.libraryWidth);

const soundPatterns = {
    click: [440, 660],
    confirm: [392, 523, 784],
    close: [440, 330],
    complete: [523, 659, 784, 1047],
};
let audioContext;

async function playSound(name) {
    if (!preferences.sound || !window.AudioContext) return;
    try {
        audioContext ??= new AudioContext();
        if (audioContext.state === "suspended") await audioContext.resume();
        if (!preferences.sound || audioContext.state !== "running") return;
        const start = audioContext.currentTime;
        soundPatterns[name].forEach((frequency, index) => {
            const time = start + index * 0.065;
            const note = audioContext.createOscillator();
            const envelope = audioContext.createGain();
            note.type = "square";
            note.frequency.value = frequency;
            envelope.gain.setValueAtTime(0.001, time);
            envelope.gain.exponentialRampToValueAtTime(0.025, time + 0.008);
            envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
            note.connect(envelope).connect(audioContext.destination);
            note.start(time);
            note.stop(time + 0.065);
        });
    } catch { /* Audio feedback is optional. */ }
}

function renderSoundToggle() {
    soundToggle.setAttribute("aria-pressed", String(preferences.sound));
    soundToggle.firstElementChild.textContent = preferences.sound ? "volume_up" : "volume_off";
}
soundToggle.addEventListener("click", () => {
    preferences.sound = !preferences.sound;
    renderSoundToggle();
    savePreferences();
    playSound("confirm");
});
renderSoundToggle();

document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button === soundToggle || button.disabled) return;
    const quiet = ["drag-player", "resize-player", "commit-edit"];
    if (quiet.includes(button.id)) return;
    playSound(["library-close", "cancel-edit", "dock-player"].includes(button.id) ? "close" : "click");
});

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
    $("media-error-text").textContent = message;
    $("open-source").href = url;
    $("open-source-label").textContent = label;
    $("media-error").hidden = false;
}

function stopPlayback() {
    if (!playback) return;
    const previous = playback;
    playback = null;
    previous.controller?.destroy();
    previous.node?.pause?.();
    previous.node?.remove();
    previous.host.replaceChildren();
}

function markPlaying(active) {
    if (playback !== active || active.recorded) return;
    active.recorded = true;
    recordPlay(active.source);
}

async function mountPlayback(source, host, position = 0, autoplay = true, recorded = false) {
    stopPlayback();
    const active = { source, host, recorded, position, autoplay };
    playback = active;
    const doc = host.ownerDocument;

    if (source.type === "direct") {
        const video = doc.createElement("video");
        active.node = video;
        video.controls = true;
        video.playsInline = true;
        video.autoplay = autoplay;
        video.src = source.url;
        video.addEventListener("loadedmetadata", () => {
            if (position && position < video.duration) video.currentTime = position;
        }, { once: true });
        video.addEventListener("playing", () => markPlaying(active));
        video.addEventListener("ended", () => {
            if (playback === active) setWatched(source, true);
        });
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
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
        iframe.src = url.href;
        host.append(iframe);
        active.controller = new YT.Player(iframe, {
            events: {
                onReady(event) {
                    if (playback !== active) return;
                    active.ready = true;
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
                    if (event.data === YT.PlayerState.ENDED) setWatched(source, true);
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
    current = { ...source };
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
        return { position: active.node.currentTime, autoplay: !active.node.paused, recorded: active.recorded };
    }
    if (!active.ready) return active;
    return {
        position: active.controller.getCurrentTime() || 0,
        autoplay: [YT.PlayerState.PLAYING, YT.PlayerState.BUFFERING].includes(active.controller.getPlayerState()),
        recorded: active.recorded,
    };
}

function transferPlayback(host) {
    const { position, autoplay, recorded } = playbackState();
    mountPlayback(current, host, position, autoplay, recorded);
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
            positionPlayer(rect.left, rect.top, width, height);
        } else {
            positionPlayer(rect.left + dx, rect.top + dy, rect.width, rect.height);
        }
    }

    let drag;
    handle.addEventListener("pointerdown", event => {
        if (!event.isPrimary || event.button !== 0 || document.fullscreenElement) return;
        drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, rect: shell.getBoundingClientRect() };
        handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
        if (event.pointerId === drag?.pointer) apply(drag.rect, event.clientX - drag.x, event.clientY - drag.y);
    });
    handle.addEventListener("lostpointercapture", () => { drag = null; });
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
$("reset-player").addEventListener("click", dockPlayer);
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
