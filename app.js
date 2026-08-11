(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // browser support check -- File System Access API is Chromium-only
  // (Chrome/Edge/Brave/Opera) as of today; no Firefox, no Safari
  // ---------------------------------------------------------------------
  const supportsFSA = 'showDirectoryPicker' in window;

  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];

  const SUB_FONTS = {
    sans: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
    serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
    mono: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
  };

  const SUB_DEFAULTS = {
    font: 'sans',
    size: 4.2,        // % of player height
    bold: true,
    italic: false,
    color: '#ffffff',
    bgEnabled: true,
    bgColor: '#000000',
    bgOpacity: 0.72,
    offsetX: 0,       // % of player width, from centre
    offsetY: 9,       // % of player height, from bottom
  };

  const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm'];
  const IGNORED_DIR_NAMES = new Set(['metadata']);

  const METADATA_DEFAULTS = {
    'progress.json': { lessons: {}, lastLessonId: null, updatedAt: null },
    'notes.json': { notes: [] },
    'preferences.json': {
      darkMode: true,
      theaterMode: false,
      volume: 1,
      playbackRate: 1,
      subtitlesOn: true,
      uiScale: 100,
      expandState: {},
      bgMusicOn: false,
      bgMusicVolume: 0.1,
      bgMusicSpeed: 1,
    },
    'durations.json': {},
  };

  // ---------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------
  const state = {
    manifest: null,
    progress: { lessons: {}, lastLessonId: null },
    notes: { notes: [] },
    prefs: {
      darkMode: true, theaterMode: false, volume: 1,
      playbackRate: 1, subtitlesOn: true, uiScale: 100,
      expandState: {},
      subtitle: { ...SUB_DEFAULTS },
      bgMusicOn: false, bgMusicVolume: 0.1, bgMusicSpeed: 1,
    },
    durations: {},
    currentChapter: null,
    currentLesson: null,
  };

  let dirty = false;

  // =====================================================================
  // REMEMBERED FOLDER -- caches the picked FileSystemDirectoryHandle in
  // IndexedDB so a returning visitor doesn't have to browse to their
  // course folder again. No separate "reconnect" screen or copy change --
  // the picker stays exactly one button; this just makes that button (or
  // the initial load, if the browser still trusts the permission) skip
  // straight past the file-tree navigation.
  // =====================================================================
  const DB_NAME = 'course-tool';
  const STORE_NAME = 'handles';
  const HANDLE_KEY = 'courseDir';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // =====================================================================
  // METADATA (progress / notes / preferences / durations) -- read/write
  // directly against metadata/ inside the picked course folder, same
  // shape and defaults as the old server ever wrote to disk.
  // =====================================================================
  let metaDirHandle = null;
  let noteImagesDirHandle = null;

  async function ensureMetadata(courseDirHandle) {
    metaDirHandle = await courseDirHandle.getDirectoryHandle('metadata', { create: true });
    noteImagesDirHandle = await metaDirHandle.getDirectoryHandle('note-images', { create: true });
    for (const [file, def] of Object.entries(METADATA_DEFAULTS)) {
      try {
        await metaDirHandle.getFileHandle(file);
      } catch {
        await writeMetaJson(file, def);
      }
    }
  }
  async function readMetaJson(file, fallback) {
    try {
      const fh = await metaDirHandle.getFileHandle(file);
      const f = await fh.getFile();
      return JSON.parse(await f.text());
    } catch {
      return fallback;
    }
  }
  async function writeMetaJson(file, data) {
    const fh = await metaDirHandle.getFileHandle(file, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(data, null, 2));
    await w.close();
  }
  async function saveNoteImage(dataUrl) {
    const m = dataUrl.match(/^data:(.+);base64,(.*)$/);
    if (!m) return null;
    const ext = '.' + m[1].split('/')[1].replace('jpeg', 'jpg');
    const fileName = crypto.randomUUID() + ext;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const fh = await noteImagesDirHandle.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return fileName;
  }
  async function getNoteImageUrl(fileName) {
    const fh = await noteImagesDirHandle.getFileHandle(fileName);
    const f = await fh.getFile();
    return URL.createObjectURL(f);
  }
  async function deleteNoteImage(fileName) {
    try {
      await noteImagesDirHandle.removeEntry(fileName);
    } catch {}
  }
  async function writeDuration(id, seconds) {
    state.durations[id] = seconds;
    try {
      await writeMetaJson('durations.json', state.durations);
    } catch {}
  }

  // =====================================================================
  // COURSE SCANNING -- ported from the old server's fs-based scanCourse/
  // scanNode. Numbering (#1, #1.6, #1.6.2 ...) is still the source of
  // truth for order and nesting; nothing about chapter count, subfolder
  // presence, or depth is hardcoded.
  // =====================================================================
  function extractNumberParts(name) {
    const m = name.match(/#\s*(\d+(?:\.\d+)*)/);
    if (!m) return [Infinity];
    return m[1].split('.').map((n) => parseInt(n, 10));
  }
  function compareNumberParts(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i] === undefined ? -1 : a[i];
      const bv = b[i] === undefined ? -1 : b[i];
      if (av !== bv) return av - bv;
    }
    return 0;
  }
  function isChapterFolder(name) {
    return /chapter\s*#?\s*\d+/i.test(name);
  }
  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i).toLowerCase();
  }
  function stripExt(fileName) {
    const ext = extOf(fileName);
    return ext ? fileName.slice(0, -ext.length) : fileName;
  }
  const SUBTITLE_EXT = ['.vtt', '.srt'];
  function findSubtitleName(entries, videoFileName) {
    const base = stripExt(videoFileName).toLowerCase();
    const match = entries.find(
      ([name, handle]) => handle.kind === 'file' && SUBTITLE_EXT.includes(extOf(name)) && stripExt(name).toLowerCase().startsWith(base)
    );
    return match ? match[0] : null;
  }
  async function listEntries(dirHandle) {
    const entries = [];
    for await (const pair of dirHandle.entries()) entries.push(pair);
    return entries;
  }

  async function scanNode(dirHandle, idPrefix) {
    const entries = await listEntries(dirHandle);
    const items = [];
    for (const [name, handle] of entries) {
      if (handle.kind === 'file') {
        if (!VIDEO_EXT.includes(extOf(name))) continue;
        const vttName = findSubtitleName(entries, name);
        const id = idPrefix ? idPrefix + '/' + name : name;
        items.push({
          type: 'video',
          num: extractNumberParts(name),
          id,
          name: stripExt(name),
          fileHandle: handle,
          subtitleHandle: vttName ? entries.find(([n]) => n === vttName)[1] : null,
        });
      } else {
        if (IGNORED_DIR_NAMES.has(name.toLowerCase())) continue;
        const childId = idPrefix ? idPrefix + '/' + name : name;
        const children = await scanNode(handle, childId);
        if (children.length > 0) {
          items.push({ type: 'group', num: extractNumberParts(name), id: childId, name, children });
        }
      }
    }
    items.sort((a, b) => compareNumberParts(a.num, b.num));
    return items;
  }

  async function scanCourse(courseDirHandle) {
    const entries = await listEntries(courseDirHandle);
    const chapterEntries = entries.filter(([name, handle]) => handle.kind === 'directory' && isChapterFolder(name));
    chapterEntries.sort((a, b) => compareNumberParts(extractNumberParts(a[0]), extractNumberParts(b[0])));
    const chapters = [];
    for (const [name, handle] of chapterEntries) {
      const children = await scanNode(handle, name);
      if (children.length > 0) chapters.push({ id: name, name, children });
    }
    return { courseName: courseDirHandle.name, chapters };
  }

  // "chapter #2.2 - practising production" -> "2.2"
  function numberOf(name) {
    const m = String(name).match(/#\s*(\d+(?:\.\d+)*)/);
    return m ? m[1] : '';
  }
  // strip the leading "chapter #N -" / "#N -" prefix for cleaner display
  function prettyName(name) {
    return String(name)
      .replace(/^\s*chapter\s*#?\s*[\d.]+\s*[-–—:]?\s*/i, '')
      .replace(/^\s*#\s*[\d.]+\s*[-–—:]?\s*/, '')
      .replace(/[_@]+/g, ' ')
      .trim() || String(name);
  }
  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : m;
    return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
  }

  // =====================================================================
  // FOLDER PICKER
  // =====================================================================
  const pickerScreen = document.getElementById('pickerScreen');
  const appScreen = document.getElementById('appScreen');
  const pickerError = document.getElementById('pickerError');
  const pickerUnsupported = document.getElementById('pickerUnsupported');
  const chooseFolderBtn = document.getElementById('chooseFolderBtn');

  function showPickerScreen() {
    pickerScreen.classList.add('visible');
    appScreen.classList.remove('visible');
  }

  async function useCourseDir(dirHandle) {
    pickerError.textContent = '';
    try {
      // validate BEFORE creating metadata/ -- an accidental wrong-folder
      // pick (e.g. a single chapter subfolder) should never leave a stray
      // metadata folder behind just because it got rejected afterward
      const manifest = await scanCourse(dirHandle);
      if (manifest.chapters.length === 0) {
        pickerError.textContent = 'This doesn\'t look like a valid course folder — no "chapter #N" folders with videos were found inside it.';
        return false;
      }
      await ensureMetadata(dirHandle);
      state.manifest = manifest;
      await idbSet(HANDLE_KEY, dirHandle);
      await bootApp();
      return true;
    } catch (e) {
      pickerError.textContent = e.message || 'Could not read that folder.';
      return false;
    }
  }

  chooseFolderBtn.addEventListener('click', async () => {
    try {
      // try the remembered folder first -- if the browser still trusts it,
      // this is a quick "allow access to X?" confirm, not a full re-browse
      const stored = await idbGet(HANDLE_KEY).catch(() => null);
      if (stored) {
        const perm = await stored.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
        if (perm === 'granted') {
          await useCourseDir(stored);
          return;
        }
      }
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await useCourseDir(dirHandle);
    } catch (e) {
      if (e.name !== 'AbortError') pickerError.textContent = e.message;
    }
  });

  async function init() {
    if (!supportsFSA) {
      pickerUnsupported.hidden = false;
      chooseFolderBtn.disabled = true;
      showPickerScreen();
      return;
    }
    // fully silent path: if the browser still trusts the last-used folder
    // with no prompt needed at all, skip the picker screen entirely
    const stored = await idbGet(HANDLE_KEY).catch(() => null);
    if (stored) {
      try {
        const perm = await stored.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted' && (await useCourseDir(stored))) return;
      } catch {}
      // browser still remembers the folder but wants a fresh confirm --
      // that confirm dialog can only ever be triggered by a direct click
      // (browsers block permission prompts on page load with no gesture,
      // on purpose, so sites can't spam them), so there's no way to skip
      // this one click entirely. Label the button so that click is
      // obviously the only remaining step, not a separate "start over"
      // action, since chooseFolderBtn's own handler already tries this
      // exact stored handle first before falling back to a full picker.
      chooseFolderBtn.textContent = 'Continue with "' + stored.name + '"';
    }
    showPickerScreen();
  }

  // =====================================================================
  // BOOT
  // =====================================================================
  async function loadBgMusicFile() {
    try {
      const assetsDir = await metaDirHandle.getDirectoryHandle('assets');
      const fh = await assetsDir.getFileHandle('bg-music.mp3');
      const file = await fh.getFile();
      bgMusicAudio.src = URL.createObjectURL(file);
    } catch {
      // no metadata/assets/bg-music.mp3 shipped with this course -- the
      // toggle just won't have anything audible to play, which is fine
    }
  }

  async function bootApp() {
    const [progress, notes, prefs, durations] = await Promise.all([
      readMetaJson('progress.json', { lessons: {}, lastLessonId: null }),
      readMetaJson('notes.json', { notes: [] }),
      readMetaJson('preferences.json', {}),
      readMetaJson('durations.json', {}),
    ]);
    state.progress = progress;
    state.notes = notes;
    state.prefs = { ...state.prefs, ...prefs };
    state.prefs.subtitle = { ...SUB_DEFAULTS, ...(prefs.subtitle || {}) };
    state.durations = durations;

    await loadBgMusicFile();

    pickerScreen.classList.remove('visible');
    appScreen.classList.add('visible');

    document.getElementById('courseTitle').textContent = state.manifest.courseName;
    applyPrefs();
    renderChapterList();
    probeUnknownDurations();
    checkCourseUpToDate();

    let toOpen = null;
    if (state.progress.lastLessonId) toOpen = findLessonById(state.progress.lastLessonId);
    if (!toOpen) {
      const first = state.manifest.chapters[0];
      toOpen = { chapter: first, lesson: firstVideoIn(first) };
    }
    if (toOpen && toOpen.lesson) await loadLesson(toOpen.chapter, toOpen.lesson, true);

    updateProgressSummary();
  }

  // ---- recursive tree helpers ----
  function flattenVideos(node) {
    const out = [];
    for (const child of node.children || []) {
      if (child.type === 'video') out.push(child);
      else out.push(...flattenVideos(child));
    }
    return out;
  }
  function firstVideoIn(node) {
    const all = flattenVideos(node);
    return all.length ? all[0] : null;
  }
  function findLessonById(id) {
    for (const ch of state.manifest.chapters) {
      const match = flattenVideos(ch).find((v) => v.id === id);
      if (match) return { chapter: ch, lesson: match };
    }
    return null;
  }
  function allVideosFlat() {
    const out = [];
    for (const ch of state.manifest.chapters) out.push(...flattenVideos(ch));
    return out;
  }

  // =====================================================================
  // ELEMENTS
  // =====================================================================
  const player = document.getElementById('player');
  const video = document.getElementById('video');
  const clickCatcher = document.getElementById('clickCatcher');
  const centerFlash = document.getElementById('centerFlash');
  const flashIcon = document.getElementById('flashIcon');
  const bufferSpinner = document.getElementById('bufferSpinner');
  const nowPlayingLabel = document.getElementById('nowPlayingLabel');

  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const prevChapterBtn = document.getElementById('prevChapterBtn');
  const nextChapterBtn = document.getElementById('nextChapterBtn');
  const back5Btn = document.getElementById('back5Btn');
  const fwd5Btn = document.getElementById('fwd5Btn');

  const muteBtn = document.getElementById('muteBtn');
  const volIconHigh = document.getElementById('volIconHigh');
  const volIconMuted = document.getElementById('volIconMuted');
  const volumeGroup = document.getElementById('volumeGroup');
  const volumeSlider = document.getElementById('volumeSlider');

  const seek = document.getElementById('seek');
  const seekFill = document.getElementById('seekFill');
  const seekBuffered = document.getElementById('seekBuffered');
  const seekThumb = document.getElementById('seekThumb');
  const seekTooltip = document.getElementById('seekTooltip');
  const noteMarkersEl = document.getElementById('noteMarkers');

  const timeDisplay = document.getElementById('timeDisplay');
  const ccBtn = document.getElementById('ccBtn');

  const theaterBtn = document.getElementById('theaterBtn');
  const theaterOnIcon = document.getElementById('theaterOnIcon');
  const theaterOffIcon = document.getElementById('theaterOffIcon');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const fsEnterIcon = document.getElementById('fsEnterIcon');
  const fsExitIcon = document.getElementById('fsExitIcon');
  const fsChaptersBtn = document.getElementById('fsChaptersBtn');
  const fsDrawerInner = document.getElementById('fsDrawerInner');

  const speedBtn = document.getElementById('speedBtn');
  const speedMenu = document.getElementById('speedMenu');
  const subSettingsBtn = document.getElementById('subSettingsBtn');
  const subSettingsPanel = document.getElementById('subSettingsPanel');

  const bgMusicAudio = document.getElementById('bgMusicAudio');
  const bgMusicBtn = document.getElementById('bgMusicBtn');
  const bgMusicSettingsBtn = document.getElementById('bgMusicSettingsBtn');
  const bgMusicPanel = document.getElementById('bgMusicPanel');
  const bgMusicVolume = document.getElementById('bgMusicVolume');
  const bgMusicVolVal = document.getElementById('bgMusicVolVal');
  const bgMusicSpeed = document.getElementById('bgMusicSpeed');
  const bgMusicSpeedVal = document.getElementById('bgMusicSpeedVal');

  const subtitleLayer = document.getElementById('subtitleLayer');
  const subtitleCue = document.getElementById('subtitleCue');

  const mainLayout = document.getElementById('mainLayout');

  // =====================================================================
  // SUBTITLES -- parsed and matched by hand rather than relying on the
  // native <track>/TextTrack API. That was the original design, but its
  // cue-firing turned out to be unreliable across repeated lesson
  // switches (textTrack mode/readiness has real, hard-to-pin-down timing
  // quirks in this exact remove-and-recreate-per-lesson usage pattern).
  // Since this player never uses native caption painting anyway -- cues
  // are always rendered into our own styled overlay -- there's nothing
  // the native track machinery was buying us. Parsing the .vtt text
  // directly and matching against video.currentTime on every timeupdate
  // sidesteps that whole class of bug.
  // =====================================================================
  let currentCues = [];

  // Handles both WebVTT (period ms separator, "WEBVTT" header) and SRT
  // (comma ms separator, no header) -- this course ships a mix of both,
  // and the two formats are otherwise close enough that one parser
  // covers both: numbered/labeled blocks are skipped automatically since
  // this only ever looks for lines matching the timestamp pattern.
  function parseVtt(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const timeRe = /(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})/;
    const toSeconds = (h, m, s, ms) => (h ? parseInt(h, 10) : 0) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;
    const cues = [];
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(timeRe);
      if (m) {
        const start = toSeconds(m[1], m[2], m[3], m[4]);
        const end = toSeconds(m[5], m[6], m[7], m[8]);
        i++;
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
          textLines.push(lines[i]);
          i++;
        }
        const cueText = textLines.join('\n').replace(/<[^>]+>/g, '').trim();
        if (cueText) cues.push({ start, end, text: cueText });
      }
      i++;
    }
    return cues;
  }

  function applySubtitleStyles() {
    const s = state.prefs.subtitle;
    subtitleCue.style.fontFamily = SUB_FONTS[s.font] || SUB_FONTS.sans;
    subtitleCue.style.fontWeight = s.bold ? '750' : '400';
    subtitleCue.style.fontStyle = s.italic ? 'italic' : 'normal';
    subtitleCue.style.color = s.color;
    subtitleCue.style.background = s.bgEnabled ? hexToRgba(s.bgColor, s.bgOpacity) : 'transparent';
    subtitleCue.style.left = `${50 + Number(s.offsetX)}%`;
    subtitleCue.style.bottom = `${s.offsetY}%`;
    sizeSubtitleLayer();
  }

  // font-size tracks the player height so subtitles scale in fullscreen
  function sizeSubtitleLayer() {
    const h = player.clientHeight || 0;
    subtitleLayer.style.fontSize = (h * (state.prefs.subtitle.size / 100)) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(sizeSubtitleLayer).observe(player);
  window.addEventListener('resize', sizeSubtitleLayer);

  function renderActiveCues() {
    if (!currentCues.length || state.prefs.subtitlesOn === false) {
      subtitleCue.classList.remove('visible');
      return;
    }
    const t = video.currentTime;
    const text = currentCues
      .filter((c) => t >= c.start && t <= c.end)
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (!text) {
      subtitleCue.classList.remove('visible');
      return;
    }
    subtitleCue.textContent = text;
    subtitleCue.classList.add('visible');
  }

  // ---- settings panel wiring ----
  const subFontSeg = document.getElementById('subFontSeg');
  const subBoldBtn = document.getElementById('subBoldBtn');
  const subItalicBtn = document.getElementById('subItalicBtn');
  const subSize = document.getElementById('subSize');
  const subSizeVal = document.getElementById('subSizeVal');
  const subColor = document.getElementById('subColor');
  const subBgEnabled = document.getElementById('subBgEnabled');
  const subBgColor = document.getElementById('subBgColor');
  const subBgOpacity = document.getElementById('subBgOpacity');
  const subBgOpacityVal = document.getElementById('subBgOpacityVal');
  const subX = document.getElementById('subX');
  const subXVal = document.getElementById('subXVal');
  const subY = document.getElementById('subY');
  const subYVal = document.getElementById('subYVal');
  const subResetBtn = document.getElementById('subResetBtn');

  function syncSubtitleControls() {
    const s = state.prefs.subtitle;
    subFontSeg.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.font === s.font));
    subBoldBtn.classList.toggle('active', !!s.bold);
    subItalicBtn.classList.toggle('active', !!s.italic);
    subSize.value = s.size;      subSizeVal.textContent = Number(s.size).toFixed(1) + '%';
    subColor.value = s.color;
    subBgEnabled.checked = !!s.bgEnabled;
    subBgColor.value = s.bgColor;
    subBgOpacity.value = s.bgOpacity;
    subBgOpacityVal.textContent = Math.round(s.bgOpacity * 100) + '%';
    subX.value = s.offsetX;      subXVal.textContent = s.offsetX;
    subY.value = s.offsetY;      subYVal.textContent = s.offsetY;
  }

  function updateSub(patch) {
    Object.assign(state.prefs.subtitle, patch);
    applySubtitleStyles();
    syncSubtitleControls();
    markDirty();
  }

  subFontSeg.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => updateSub({ font: b.dataset.font })));
  subBoldBtn.addEventListener('click', () => updateSub({ bold: !state.prefs.subtitle.bold }));
  subItalicBtn.addEventListener('click', () => updateSub({ italic: !state.prefs.subtitle.italic }));
  subSize.addEventListener('input', () => updateSub({ size: parseFloat(subSize.value) }));
  subColor.addEventListener('input', () => updateSub({ color: subColor.value }));
  subBgEnabled.addEventListener('change', () => updateSub({ bgEnabled: subBgEnabled.checked }));
  subBgColor.addEventListener('input', () => updateSub({ bgColor: subBgColor.value }));
  subBgOpacity.addEventListener('input', () => updateSub({ bgOpacity: parseFloat(subBgOpacity.value) }));
  subX.addEventListener('input', () => updateSub({ offsetX: parseInt(subX.value, 10) }));
  subY.addEventListener('input', () => updateSub({ offsetY: parseInt(subY.value, 10) }));
  subResetBtn.addEventListener('click', () => updateSub({ ...SUB_DEFAULTS }));

  // =====================================================================
  // PLAYBACK
  // =====================================================================
  function flash(isPlayIcon) {
    flashIcon.innerHTML = isPlayIcon
      ? '<path d="M8 5v14l11-7z"/>'
      : '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
    centerFlash.classList.remove('show');
    void centerFlash.offsetWidth;
    centerFlash.classList.add('show');
  }
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  const seekFlashBack = document.getElementById('seekFlashBack');
  const seekFlashFwd = document.getElementById('seekFlashFwd');
  function flashSeek(forward) {
    const el = forward ? seekFlashFwd : seekFlashBack;
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation on repeated presses
    el.classList.add('show');
  }
  function seekBy(delta) {
    if (!isFinite(video.duration)) return;
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta));
    flashSeek(delta > 0);
  }
  function setVolume(v) {
    video.volume = Math.min(1, Math.max(0, v));
    video.muted = video.volume === 0;
    volumeSlider.value = video.volume;
    updateVolumeIcon();
    state.prefs.volume = video.volume;
    markDirty();
  }

  video.addEventListener('play', () => {
    player.classList.add('is-playing');
    playIcon.classList.add('icon-alt');
    pauseIcon.classList.remove('icon-alt');
    showUI();
    syncBgMusicPlayback();
  });
  video.addEventListener('pause', () => {
    player.classList.remove('is-playing');
    playIcon.classList.remove('icon-alt');
    pauseIcon.classList.add('icon-alt');
    markDirty();
    saveNow();
    syncBgMusicPlayback();
  });
  video.addEventListener('waiting', () => bufferSpinner.classList.add('show'));
  video.addEventListener('playing', () => bufferSpinner.classList.remove('show'));
  video.addEventListener('canplay', () => bufferSpinner.classList.remove('show'));
  video.addEventListener('ended', () => {
    markDirty();
    saveNow();
    goToRelativeLesson(1);
  });

  // moves to the previous/next video in overall course order (flattened
  // across all chapters and sub-chapters) and starts playing it; no-ops
  // silently if already at the first/last video in the course
  function goToRelativeLesson(delta) {
    if (!state.currentLesson) return;
    const all = allVideosFlat();
    const idx = all.findIndex((v) => v.id === state.currentLesson.id);
    const target = all[idx + delta];
    if (!target) return;
    const found = findLessonById(target.id);
    if (found) loadLesson(found.chapter, found.lesson);
  }

  playBtn.addEventListener('click', togglePlay);
  prevChapterBtn.addEventListener('click', () => goToRelativeLesson(-1));
  nextChapterBtn.addEventListener('click', () => goToRelativeLesson(1));
  back5Btn.addEventListener('click', () => seekBy(-5));
  fwd5Btn.addEventListener('click', () => seekBy(5));
  clickCatcher.addEventListener('click', () => { flash(video.paused); togglePlay(); });

  function updateSeekUI() {
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    seekFill.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
    timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    if (video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      seekBuffered.style.width = (video.duration ? (end / video.duration) * 100 : 0) + '%';
    }
  }
  video.addEventListener('timeupdate', () => { updateSeekUI(); trackWatchProgress(); renderActiveCues(); });
  video.addEventListener('seeked', renderActiveCues);
  video.addEventListener('loadedmetadata', () => {
    updateSeekUI();
    renderNoteMarkers();
    reportDurationIfNeeded();
    sizeSubtitleLayer();
  });
  video.addEventListener('progress', updateSeekUI);

  // seek dragging
  let seeking = false;
  function seekToClientX(clientX) {
    const rect = seek.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (video.duration) video.currentTime = pct * video.duration;
  }
  seek.addEventListener('pointerdown', (e) => {
    seeking = true;
    seek.classList.add('dragging');
    seekToClientX(e.clientX);
    seek.setPointerCapture(e.pointerId);
  });
  seek.addEventListener('pointermove', (e) => {
    if (seeking) seekToClientX(e.clientX);
    const rect = seek.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seekTooltip.style.left = pct * 100 + '%';
    seekTooltip.textContent = fmtTime((video.duration || 0) * pct);
  });
  seek.addEventListener('pointerup', (e) => {
    seeking = false;
    seek.classList.remove('dragging');
    try { seek.releasePointerCapture(e.pointerId); } catch {}
    markDirty();
  });

  function updateVolumeIcon() {
    const muted = video.muted || video.volume === 0;
    volIconHigh.classList.toggle('icon-alt', muted);
    volIconMuted.classList.toggle('icon-alt', !muted);
  }
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
    volumeSlider.value = video.muted ? 0 : video.volume;
    updateVolumeIcon();
    markDirty();
  });
  volumeSlider.addEventListener('input', () => setVolume(parseFloat(volumeSlider.value)));

  ccBtn.addEventListener('click', () => {
    state.prefs.subtitlesOn = !state.prefs.subtitlesOn;
    ccBtn.classList.toggle('active', state.prefs.subtitlesOn);
    renderActiveCues();
    markDirty();
  });

  // ---- speed ----
  function renderSpeedMenu() {
    speedMenu.innerHTML = '';
    SPEEDS.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'speed-opt' + (s === state.prefs.playbackRate ? ' active' : '');
      b.textContent = s + '×';
      b.onclick = () => setSpeed(s);
      speedMenu.appendChild(b);
    });
  }
  function setSpeed(s) {
    state.prefs.playbackRate = s;
    video.playbackRate = s;
    video.defaultPlaybackRate = s;
    // keep audio pitch natural at every speed
    video.preservesPitch = true;
    video.mozPreservesPitch = true;
    video.webkitPreservesPitch = true;
    speedBtn.innerHTML = s + '&times;';
    speedMenu.classList.remove('open');
    renderSpeedMenu();
    markDirty();
  }

  function closePopovers(except) {
    [speedMenu, subSettingsPanel, bgMusicPanel].forEach((p) => { if (p !== except) p.classList.remove('open'); });
  }
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !speedMenu.classList.contains('open');
    closePopovers(speedMenu);
    speedMenu.classList.toggle('open', willOpen);
  });
  subSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !subSettingsPanel.classList.contains('open');
    closePopovers(subSettingsPanel);
    subSettingsPanel.classList.toggle('open', willOpen);
  });
  subSettingsPanel.addEventListener('click', (e) => e.stopPropagation());
  speedMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => closePopovers(null));

  // ---- background music: independent volume/speed from the course video,
  // but its play/pause state follows the video's -- playing the course
  // starts it (from within the video's own 'play' event, which still
  // counts as user-gesture-connected since it fires synchronously off
  // the click that started the video -- calling bgMusicAudio.play() any
  // other time, e.g. straight from boot, gets silently blocked by the
  // browser's autoplay policy since there's no fresh gesture to attach to),
  // pausing the course pauses it too. ----
  function syncBgMusicPlayback() {
    const shouldPlay = state.prefs.bgMusicOn && !video.paused;
    if (shouldPlay && bgMusicAudio.paused) bgMusicAudio.play().catch(() => {});
    else if (!shouldPlay && !bgMusicAudio.paused) bgMusicAudio.pause();
  }
  function applyBgMusicPrefs() {
    bgMusicAudio.volume = state.prefs.bgMusicVolume;
    bgMusicAudio.playbackRate = state.prefs.bgMusicSpeed;
    bgMusicVolume.value = state.prefs.bgMusicVolume;
    bgMusicVolVal.textContent = Math.round(state.prefs.bgMusicVolume * 100) + '%';
    bgMusicSpeed.value = state.prefs.bgMusicSpeed;
    bgMusicSpeedVal.textContent = state.prefs.bgMusicSpeed + '×';
    bgMusicBtn.classList.toggle('active', state.prefs.bgMusicOn);
    syncBgMusicPlayback();
  }
  bgMusicBtn.addEventListener('click', () => {
    state.prefs.bgMusicOn = !state.prefs.bgMusicOn;
    bgMusicBtn.classList.toggle('active', state.prefs.bgMusicOn);
    syncBgMusicPlayback();
    markDirty();
  });
  bgMusicSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !bgMusicPanel.classList.contains('open');
    closePopovers(bgMusicPanel);
    bgMusicPanel.classList.toggle('open', willOpen);
  });
  bgMusicPanel.addEventListener('click', (e) => e.stopPropagation());
  bgMusicVolume.addEventListener('input', () => {
    const v = parseFloat(bgMusicVolume.value);
    state.prefs.bgMusicVolume = v;
    bgMusicAudio.volume = v;
    bgMusicVolVal.textContent = Math.round(v * 100) + '%';
    markDirty();
  });
  bgMusicSpeed.addEventListener('input', () => {
    const v = parseFloat(bgMusicSpeed.value);
    state.prefs.bgMusicSpeed = v;
    bgMusicAudio.playbackRate = v;
    bgMusicSpeedVal.textContent = v + '×';
    markDirty();
  });

  // ---- fullscreen / theater ----
  function isFullscreen() { return document.fullscreenElement === player; }
  fullscreenBtn.addEventListener('click', () => {
    if (isFullscreen()) document.exitFullscreen();
    else player.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    const fs = isFullscreen();
    fsEnterIcon.classList.toggle('icon-alt', fs);
    fsExitIcon.classList.toggle('icon-alt', !fs);
    player.classList.toggle('is-fullscreen', fs);
    if (!fs) player.classList.remove('drawer-open');
    sizeSubtitleLayer();
  });
  fsChaptersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    player.classList.toggle('drawer-open');
    if (player.classList.contains('drawer-open')) renderFsDrawer();
  });

  // In theater mode the player's height is capped so the whole thing
  // (video + controls) always stays inside the viewport, no scrolling.
  // This has to be computed in JS, not a CSS vh calc: `zoom` (used by UI
  // Scale) rescales rendered content but NOT what 100vh means, so a pure
  // CSS height would overflow more and more as UI Scale goes up -- which
  // is exactly the bug this fixes. getBoundingClientRect() already
  // reports real, post-zoom screen pixels, so we measure with that and
  // convert back into the pre-zoom CSS height the browser needs to set.
  function syncTheaterPlayerHeight() {
    if (!mainLayout.classList.contains('theater')) {
      player.style.height = '';
      return;
    }
    const zoom = (state.prefs.uiScale || 100) / 100;
    const topbarBottom = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const bottomBuffer = 40; // real screen px of breathing room below the player
    const availableRealPx = window.innerHeight - topbarBottom - bottomBuffer;
    player.style.height = Math.max(200, availableRealPx / zoom) + 'px';
  }
  window.addEventListener('resize', syncTheaterPlayerHeight);

  function setTheater(on) {
    state.prefs.theaterMode = on;
    mainLayout.classList.toggle('theater', on);
    theaterOnIcon.classList.toggle('icon-alt', on);
    theaterOffIcon.classList.toggle('icon-alt', !on);
    sizeSubtitleLayer();
    syncTheaterPlayerHeight();
    markDirty();
  }
  theaterBtn.addEventListener('click', () => setTheater(!state.prefs.theaterMode));

  // ---- auto-hide controls ----
  let hideTimer = null;
  function showUI() {
    player.classList.add('show-ui');
    clearTimeout(hideTimer);
    if (!video.paused) {
      hideTimer = setTimeout(() => {
        if (!speedMenu.classList.contains('open') && !subSettingsPanel.classList.contains('open')) {
          player.classList.remove('show-ui');
        }
      }, 2400);
    }
  }
  player.addEventListener('pointermove', showUI);
  player.addEventListener('pointerdown', showUI);
  showUI();

  // =====================================================================
  // KEYBOARD SHORTCUTS
  // Buttons carry tabindex="-1" and we blur any focused control, so Space
  // can never both "click the focused button" and run this handler (that
  // double-toggle is what made play/pause appear dead).
  // =====================================================================
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const el = document.activeElement;
    const tag = el ? el.tagName : '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable);
    if (typing) return;
    if (!document.getElementById('allNotesModal').hidden) {
      if (e.key === 'Escape') document.getElementById('allNotesModal').hidden = true;
      return;
    }

    const code = e.code;
    const key = e.key.toLowerCase();

    if (code === 'Space' || key === 'k') {
      e.preventDefault();
      if (el && el.blur) el.blur();
      flash(video.paused);
      togglePlay();
      showUI();
      return;
    }
    if (code === 'ArrowRight') { e.preventDefault(); seekBy(5);  showUI(); return; }
    if (code === 'ArrowLeft')  { e.preventDefault(); seekBy(-5); showUI(); return; }
    if (code === 'ArrowUp')    { e.preventDefault(); setVolume(video.volume + 0.05); showUI(); return; }
    if (code === 'ArrowDown')  { e.preventDefault(); setVolume(video.volume - 0.05); showUI(); return; }

    if (key === 'f') { e.preventDefault(); fullscreenBtn.click(); return; }
    if (key === 'c') { e.preventDefault(); ccBtn.click(); return; }
    if (key === 'm') { e.preventDefault(); muteBtn.click(); return; }
    if (key === 't') { e.preventDefault(); setTheater(!state.prefs.theaterMode); return; }
    if (e.shiftKey && key === 'n') { e.preventDefault(); nextChapterBtn.click(); return; }
    if (e.shiftKey && key === 'p') { e.preventDefault(); prevChapterBtn.click(); return; }
    if (key === 'n') { e.preventDefault(); addNoteBtn.click(); return; }
    if (e.key === 'Escape') closePopovers(null);
  });

  // =====================================================================
  // PREFERENCES
  // =====================================================================
  function applyTheme() {
    const dark = !!state.prefs.darkMode;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.getElementById('themeText').textContent = dark ? 'Dark mode' : 'Light mode';
    document.querySelector('.theme-sun').classList.toggle('icon-alt', dark);
    document.querySelector('.theme-moon').classList.toggle('icon-alt', !dark);
  }

  function applyPrefs() {
    applyTheme();
    setTheater(!!state.prefs.theaterMode);
    volumeSlider.value = state.prefs.volume;
    video.volume = state.prefs.volume;
    updateVolumeIcon();
    setSpeed(state.prefs.playbackRate || 1);
    ccBtn.classList.toggle('active', state.prefs.subtitlesOn !== false);
    applySubtitleStyles();
    syncSubtitleControls();
    applyUiScale(state.prefs.uiScale || 100);
    applyBgMusicPrefs();
    dirty = false;
  }

  document.getElementById('darkModeBtn').addEventListener('click', () => {
    state.prefs.darkMode = !state.prefs.darkMode;
    applyTheme();
    markDirty();
    saveNow();
  });

  // =====================================================================
  // UPDATE COURSE -- compares the locally picked folder's structure
  // against a manually-maintained reference JSON published in this same
  // repo, so buyers can tell when a newer version of the course exists
  // without any of us needing to build real update-delivery machinery.
  // =====================================================================
  const REFERENCE_STRUCTURE_URL = 'https://raw.githubusercontent.com/stache-obj/course-viewer/master/course-structure.json';
  const updateCourseBtn = document.getElementById('updateCourseBtn');
  const updateCourseLabel = document.getElementById('updateCourseLabel');

  function toComparableShape(items) {
    return items.map((it) => it.type === 'video'
      ? { type: 'video', name: it.name }
      : { type: 'group', name: it.name, children: toComparableShape(it.children) });
  }

  async function checkCourseUpToDate() {
    try {
      const res = await fetch(REFERENCE_STRUCTURE_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('reference structure not reachable');
      const ref = await res.json();

      const localShape = state.manifest.chapters.map((ch) => ({ name: ch.name, children: toComparableShape(ch.children) }));
      const refShape = (ref.chapters || []).map((ch) => ({ name: ch.name, children: ch.children }));
      const upToDate = JSON.stringify(localShape) === JSON.stringify(refShape);

      if (upToDate) {
        updateCourseBtn.dataset.state = 'up-to-date';
        updateCourseLabel.textContent = 'Course is up to date';
        updateCourseBtn.title = 'Your course folder matches the latest published structure';
      } else {
        updateCourseBtn.dataset.state = 'outdated';
        updateCourseLabel.textContent = 'Update Course';
        updateCourseBtn.title = 'A newer version of the course is available';
        updateCourseBtn.dataset.driveLink = ref.driveLink || '';
      }
    } catch (e) {
      // can't verify (offline, reference not published yet, GitHub down) --
      // default to not alarming buyers with an update prompt we can't
      // actually confirm is real
      updateCourseBtn.dataset.state = 'up-to-date';
      updateCourseLabel.textContent = 'Course is up to date';
      updateCourseBtn.title = 'Could not check for updates';
    }
  }

  updateCourseBtn.addEventListener('click', () => {
    if (updateCourseBtn.dataset.state !== 'outdated') return;
    const link = updateCourseBtn.dataset.driveLink;
    if (link) window.open(link, '_blank', 'noopener');
  });

  document.getElementById('resetCourseBtn').addEventListener('click', async () => {
    const sure = confirm(
      'This permanently erases all progress, notes, and preferences. This cannot be undone. Continue?'
    );
    if (!sure) return;
    try {
      for (const [file, def] of Object.entries(METADATA_DEFAULTS)) {
        await writeMetaJson(file, def);
      }
      if (noteImagesDirHandle) {
        for await (const name of noteImagesDirHandle.keys()) {
          await noteImagesDirHandle.removeEntry(name).catch(() => {});
        }
      }
      // forget the remembered folder too, so the picker screen shows again
      // instead of silently reconnecting -- see the code comment on the
      // click handler itself for why this can't fully revoke the browser's
      // own access grant, only our app's memory of it
      await idbDelete(HANDLE_KEY).catch(() => {});
    } catch (e) {
      alert('Reset failed: ' + e.message);
      return;
    }
    location.reload();
  });

  // ---- UI scale: page zoom, so the user never needs the browser's own
  // zoom controls. `zoom` (not transform) so layout/scrollbars stay correct.
  const UI_SCALE_MIN = 60;
  const UI_SCALE_MAX = 160;
  const UI_SCALE_STEP = 10;
  const uiScaleValEl = document.getElementById('uiScaleVal');
  const uiScaleDownBtn = document.getElementById('uiScaleDown');
  const uiScaleUpBtn = document.getElementById('uiScaleUp');

  function applyUiScale(pct) {
    pct = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, pct));
    state.prefs.uiScale = pct;
    document.body.style.zoom = pct / 100;
    uiScaleValEl.textContent = pct;
    uiScaleDownBtn.disabled = pct <= UI_SCALE_MIN;
    uiScaleUpBtn.disabled = pct >= UI_SCALE_MAX;
    syncTheaterPlayerHeight();
  }
  uiScaleDownBtn.addEventListener('click', () => {
    applyUiScale((state.prefs.uiScale || 100) - UI_SCALE_STEP);
    markDirty();
  });
  uiScaleUpBtn.addEventListener('click', () => {
    applyUiScale((state.prefs.uiScale || 100) + UI_SCALE_STEP);
    markDirty();
  });

  // =====================================================================
  // LESSON LOADING
  // =====================================================================
  let currentVideoUrl = null;

  async function loadLesson(chapter, lesson, isInitial) {
    state.currentChapter = chapter;
    state.currentLesson = lesson;
    expandChapterFully(chapter);

    currentCues = [];
    subtitleCue.classList.remove('visible');

    if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);

    const videoFile = await lesson.fileHandle.getFile();
    currentVideoUrl = URL.createObjectURL(videoFile);
    video.src = currentVideoUrl;
    nowPlayingLabel.textContent = prettyName(lesson.name);

    if (lesson.subtitleHandle) {
      const subFile = await lesson.subtitleHandle.getFile();
      currentCues = parseVtt(await subFile.text());
      renderActiveCues();
    }

    const entry = state.progress.lessons[lesson.id];
    const resumeAt = entry && entry.lastPosition;
    if (resumeAt && resumeAt > 1) {
      video.addEventListener('loadedmetadata', function onceResume() {
        video.currentTime = Math.min(resumeAt, (video.duration || resumeAt) - 0.5);
        video.removeEventListener('loadedmetadata', onceResume);
      });
    }

    state.progress.lastLessonId = lesson.id;
    renderChapterList();
    renderNotesForCurrentLesson();
    markDirty();

    if (!isInitial) video.play().catch(() => {});
  }

  function reportDurationIfNeeded() {
    const lesson = state.currentLesson;
    if (!lesson || !video.duration || !isFinite(video.duration)) return;
    if (state.durations[lesson.id] !== video.duration) {
      writeDuration(lesson.id, video.duration);
      renderChapterList();
      updateProgressSummary();
    }
  }

  // Progress uses the FURTHEST point reached (maxPosition), so skipping away
  // half-way through a lesson banks that 50% and rewatching never subtracts.
  // lastPosition stays separate — that's what "resume where you left off" uses.
  function trackWatchProgress() {
    const lesson = state.currentLesson;
    if (!lesson || !video.duration || !isFinite(video.duration)) return;
    const entry = state.progress.lessons[lesson.id] || { lastPosition: 0, maxPosition: 0, completed: false };
    entry.lastPosition = video.currentTime;
    entry.maxPosition = Math.max(entry.maxPosition || 0, video.currentTime);
    entry.duration = video.duration;
    if (entry.maxPosition / video.duration > 0.95) entry.completed = true;
    state.progress.lessons[lesson.id] = entry;
    updateProgressSummary();
    updateActiveLessonRow();
  }
  function watchedSecondsFor(id) {
    const e = state.progress.lessons[id];
    if (!e) return 0;
    const val = e.maxPosition != null ? e.maxPosition : (e.lastPosition || 0);
    const dur = state.durations[id] || e.duration;
    return dur ? Math.min(val, dur) : val;
  }

  function probeUnknownDurations() {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    const unknown = allVideosFlat().filter((l) => state.durations[l.id] == null);
    let i = 0;
    let probeUrl = null;
    async function next() {
      if (probeUrl) { URL.revokeObjectURL(probeUrl); probeUrl = null; }
      if (i >= unknown.length) { renderChapterList(); return; }
      const lesson = unknown[i++];
      const file = await lesson.fileHandle.getFile();
      probeUrl = URL.createObjectURL(file);
      probe.src = probeUrl;
      probe.onloadedmetadata = () => {
        writeDuration(lesson.id, probe.duration);
        updateProgressSummary();
        if (i % 6 === 0) renderChapterList();
        next();
      };
      probe.onerror = () => next();
    }
    next();
  }

  // =====================================================================
  // SIDEBAR / CHAPTER TREE
  // =====================================================================
  const chapterListEl = document.getElementById('chapterList');
  const progressPercentEl = document.getElementById('progressPercent');
  const progressHoursEl = document.getElementById('progressHours');
  const progressFillEl = document.getElementById('progressFill');
  const ringFillEl = document.getElementById('ringFill');

  const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.5 14.5v-9l7 4.5-7 4.5z"/></svg>';
  const ICON_DONE = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 14.6-4-4 1.5-1.5 2.5 2.5 5.4-5.4L17.7 9l-6.9 7.6z"/></svg>';
  const ICON_CHEVRON = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6z"/></svg>';

  function groupContainsCurrentLesson(node) {
    if (!state.currentLesson) return false;
    return flattenVideos(node).some((v) => v.id === state.currentLesson.id);
  }

  // Every group (top-level chapter or nested sub-chapter) collapses by
  // default; only the branch that contains the currently playing lesson
  // opens automatically. Anything the user has explicitly clicked keeps
  // that choice regardless of what's playing -- and that choice is saved
  // to preferences, so a reload reopens the tree exactly as it was left.
  function isExpanded(node) {
    const saved = state.prefs.expandState[node.id];
    return saved !== undefined ? saved : groupContainsCurrentLesson(node);
  }
  function toggleExpanded(node) {
    state.prefs.expandState[node.id] = !isExpanded(node);
    markDirty();
    renderChapterList();
    renderFsDrawer();
  }

  function allDescendantGroupIds(node) {
    const ids = [];
    for (const child of node.children || []) {
      if (child.type === 'group') {
        ids.push(child.id);
        ids.push(...allDescendantGroupIds(child));
      }
    }
    return ids;
  }
  // opening a top-level chapter reveals every sub-chapter inside it too,
  // not just the chapter itself -- collapsing only hides the chapter
  function toggleChapterExpanded(ch) {
    const opening = !isExpanded(ch);
    state.prefs.expandState[ch.id] = opening;
    if (opening) for (const id of allDescendantGroupIds(ch)) state.prefs.expandState[id] = true;
    markDirty();
    renderChapterList();
    renderFsDrawer();
  }
  // fully opens whichever chapter a lesson lives in, called on every
  // navigation so the tree always reveals where the current video is
  function expandChapterFully(ch) {
    if (!ch) return;
    state.prefs.expandState[ch.id] = true;
    for (const id of allDescendantGroupIds(ch)) state.prefs.expandState[id] = true;
  }

  function buildLessonRow(les, depth) {
    const row = document.createElement('div');
    const isActive = state.currentLesson && les.id === state.currentLesson.id;
    row.className = 'lesson-row' + (isActive ? ' active' : '');
    row.style.paddingLeft = 18 + depth * 15 + 'px';

    const entry = state.progress.lessons[les.id];
    const dur = state.durations[les.id] || (entry && entry.duration);
    const done = entry && entry.completed;
    // the active row mirrors the playhead live; others show saved progress
    const watched = isActive && isFinite(video.duration) ? video.currentTime : watchedSecondsFor(les.id);
    const pct = dur ? Math.min(100, (watched / dur) * 100) : 0;
    // partially-watched but not currently playing -> show a resume hint
    const showResume = !isActive && !done && pct > 1;
    const num = numberOf(les.name);

    row.innerHTML =
      `<span class="lesson-icon${done ? ' done' : ''}">${done ? ICON_DONE : ICON_PLAY}</span>` +
      (num ? `<span class="lesson-num">${num}</span>` : '') +
      `<span class="lesson-name"></span>` +
      (showResume ? `<span class="lesson-resume">${Math.round(pct)}%</span>` : '') +
      (dur ? `<span class="lesson-dur">${fmtTime(dur)}</span>` : '') +
      `<span class="lesson-watched" style="width:${pct}%"></span>`;

    row.querySelector('.lesson-name').textContent = prettyName(les.name);
    row.title = les.name;
    row.dataset.lessonId = les.id;
    row.addEventListener('click', () => {
      const found = findLessonById(les.id);
      if (found) loadLesson(found.chapter, les);
      player.classList.remove('drawer-open');
    });
    return row;
  }

  function buildSubgroup(node, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'subgroup';
    const expanded = isExpanded(node);
    const count = flattenVideos(node).length;
    const num = numberOf(node.name);

    const head = document.createElement('div');
    head.className = 'subgroup-head' + (expanded ? ' expanded' : '');
    head.style.paddingLeft = 18 + depth * 15 + 'px';
    head.innerHTML =
      `<span class="subgroup-chevron">${ICON_CHEVRON}</span>` +
      `<span class="subgroup-dot"></span>` +
      (num ? `<span class="subgroup-num">${num}</span>` : '') +
      `<span class="subgroup-name"></span>` +
      `<span class="subgroup-count">${count}</span>`;
    head.querySelector('.subgroup-name').textContent = prettyName(node.name);
    head.title = node.name;
    head.addEventListener('click', () => toggleExpanded(node));
    wrap.appendChild(head);

    if (expanded) {
      const childWrap = document.createElement('div');
      childWrap.className = 'subgroup-children';
      renderGroupChildren(node, childWrap, depth + 1);
      wrap.appendChild(childWrap);
    }
    return wrap;
  }

  function renderGroupChildren(node, container, depth) {
    for (const child of node.children) {
      container.appendChild(
        child.type === 'video' ? buildLessonRow(child, depth) : buildSubgroup(child, depth)
      );
    }
  }

  function buildChapterListDom(container) {
    container.innerHTML = '';
    for (const ch of state.manifest.chapters) {
      const group = document.createElement('div');
      group.className = 'chapter-group';
      const expanded = isExpanded(ch);

      const head = document.createElement('div');
      head.className = 'chapter-head' + (expanded ? ' expanded' : '');
      const num = numberOf(ch.name);
      head.innerHTML =
        `<span class="chapter-num">${num || '•'}</span>` +
        `<span class="chapter-title"></span>` +
        `<span class="chapter-chevron">${ICON_CHEVRON}</span>`;
      head.querySelector('.chapter-title').textContent = prettyName(ch.name);
      head.title = ch.name;
      head.addEventListener('click', () => toggleChapterExpanded(ch));
      group.appendChild(head);

      if (expanded) {
        const childWrap = document.createElement('div');
        childWrap.className = 'chapter-children';
        renderGroupChildren(ch, childWrap, 0);
        group.appendChild(childWrap);
      }
      container.appendChild(group);
    }
  }

  function renderChapterList() {
    if (!state.manifest) return;
    const scroll = chapterListEl.scrollTop;
    buildChapterListDom(chapterListEl);
    chapterListEl.scrollTop = scroll;
  }
  function renderFsDrawer() {
    if (!state.manifest) return;
    buildChapterListDom(fsDrawerInner);
  }

  // Called on every timeupdate — moves the active lesson's bar in step with
  // the playhead without re-rendering the whole tree.
  function updateActiveLessonRow() {
    if (!state.currentLesson) return;
    const dur = state.durations[state.currentLesson.id] || video.duration;
    if (!dur || !isFinite(dur)) return;
    const pct = Math.min(100, (video.currentTime / dur) * 100);
    document
      .querySelectorAll('.lesson-row.active .lesson-watched')
      .forEach((el) => (el.style.width = pct + '%'));
  }

  function updateProgressSummary() {
    let total = 0;
    let watched = 0;
    for (const les of allVideosFlat()) {
      const dur = state.durations[les.id];
      if (dur) {
        total += dur;
        watched += watchedSecondsFor(les.id);
      }
    }
    const raw = total ? (watched / total) * 100 : 0;
    // a long course means early progress is a fraction of a percent — show a
    // decimal there so the bar visibly moves instead of sitting on "0%"
    const label = raw > 0 && raw < 10 ? raw.toFixed(1) : Math.round(raw);
    progressPercentEl.textContent = label + '%';
    progressFillEl.style.width = raw + '%';

    const C = 2 * Math.PI * 19;
    ringFillEl.style.strokeDasharray = C;
    ringFillEl.style.strokeDashoffset = C * (1 - raw / 100);

    if (!total) { progressHoursEl.textContent = 'calculating…'; return; }
    const leftH = Math.max(0, (total - watched) / 3600);
    const totalH = total / 3600;
    progressHoursEl.textContent =
      (leftH < 1 ? Math.round(leftH * 60) + ' min' : leftH.toFixed(1) + ' hrs') +
      ' left of ' + totalH.toFixed(1) + ' hrs';
  }

  // =====================================================================
  // NOTE MARKERS
  // =====================================================================
  function renderNoteMarkers() {
    noteMarkersEl.innerHTML = '';
    if (!state.currentLesson || !video.duration) return;
    state.notes.notes
      .filter((n) => n.lessonId === state.currentLesson.id)
      .forEach((n) => {
        const dot = document.createElement('div');
        dot.className = 'note-marker';
        dot.style.left = (n.timestamp / video.duration) * 100 + '%';
        dot.title = fmtTime(n.timestamp) + (n.text ? ' — ' + n.text.slice(0, 60) : '');
        noteMarkersEl.appendChild(dot);
      });
  }

  // =====================================================================
  // NOTES
  // =====================================================================
  const notesListEl = document.getElementById('notesList');
  const notesChapterChip = document.getElementById('notesChapterChip');
  const addNoteBtn = document.getElementById('addNoteBtn');
  const noteForm = document.getElementById('noteForm');
  const noteFormTime = document.getElementById('noteFormTime');
  const noteText = document.getElementById('noteText');
  const noteImage = document.getElementById('noteImage');
  const noteImageLabel = document.getElementById('noteImageLabel');
  const noteImagePreview = document.getElementById('noteImagePreview');
  const saveNoteBtn = document.getElementById('saveNoteBtn');
  const cancelNoteBtn = document.getElementById('cancelNoteBtn');

  let pendingNoteTimestamp = 0;
  let pendingImageDataUrl = null;
  let wasPlayingBeforeNote = false;

  addNoteBtn.addEventListener('click', () => {
    if (!state.currentLesson) return;
    wasPlayingBeforeNote = !video.paused;
    video.pause();
    pendingNoteTimestamp = video.currentTime;
    noteFormTime.textContent = 'At ' + fmtTime(pendingNoteTimestamp);
    noteText.value = '';
    pendingImageDataUrl = null;
    noteImage.value = '';
    noteImageLabel.textContent = 'Attach image';
    noteImagePreview.hidden = true;
    noteImagePreview.innerHTML = '';
    noteForm.hidden = false;
    noteText.focus();
  });
  cancelNoteBtn.addEventListener('click', () => {
    noteForm.hidden = true;
    if (wasPlayingBeforeNote) video.play().catch(() => {});
  });
  noteImage.addEventListener('change', () => {
    const file = noteImage.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingImageDataUrl = reader.result;
      noteImageLabel.textContent = file.name;
      noteImagePreview.hidden = false;
      noteImagePreview.innerHTML = '';
      const img = document.createElement('img');
      img.src = reader.result;
      noteImagePreview.appendChild(img);
    };
    reader.readAsDataURL(file);
  });

  saveNoteBtn.addEventListener('click', async () => {
    if (!noteText.value.trim() && !pendingImageDataUrl) return;
    saveNoteBtn.disabled = true;
    try {
      let imageFile = null;
      if (pendingImageDataUrl) {
        imageFile = await saveNoteImage(pendingImageDataUrl);
      }
      const note = {
        id: crypto.randomUUID(),
        chapterId: state.currentChapter.id,
        chapterName: state.currentChapter.name,
        lessonId: state.currentLesson.id,
        lessonName: state.currentLesson.name,
        timestamp: pendingNoteTimestamp,
        text: noteText.value.trim(),
        imageFile,
        createdAt: new Date().toISOString(),
      };
      state.notes.notes.push(note);
      await writeMetaJson('notes.json', state.notes);
      noteForm.hidden = true;
      renderNotesForCurrentLesson();
      renderNoteMarkers();
      if (wasPlayingBeforeNote) video.play().catch(() => {});
    } finally {
      saveNoteBtn.disabled = false;
    }
  });

  // Notes are per-video, not per-chapter -- each lesson has its own list.
  function renderNotesForCurrentLesson() {
    notesListEl.innerHTML = '';
    if (!state.currentLesson) return;
    notesChapterChip.textContent = prettyName(state.currentLesson.name);

    const notes = state.notes.notes
      .filter((n) => n.lessonId === state.currentLesson.id)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!notes.length) {
      notesListEl.innerHTML =
        '<div class="notes-empty">No notes on this video yet — hit <strong>Add note</strong> (or press <strong>N</strong>) while watching.</div>';
      return;
    }
    notes.forEach((n, i) => {
      const el = buildNoteItem(n, false);
      el.style.animationDelay = Math.min(i * 30, 240) + 'ms';
      notesListEl.appendChild(el);
    });
  }

  function buildNoteItem(n, showLesson) {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.innerHTML =
      `<span class="note-time-badge"></span>` +
      `<div class="note-body"><div class="note-text"></div></div>` +
      `<button class="note-del" title="Delete note"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>`;

    item.querySelector('.note-time-badge').textContent = fmtTime(n.timestamp);
    item.querySelector('.note-text').textContent = n.text;

    const body = item.querySelector('.note-body');
    if (n.imageFile) {
      const img = document.createElement('img');
      img.className = 'note-img';
      body.appendChild(img);
      getNoteImageUrl(n.imageFile).then((url) => { img.src = url; }).catch(() => {});
    }
    if (showLesson !== false) {
      const meta = document.createElement('div');
      meta.className = 'note-lesson';
      meta.textContent = prettyName(n.lessonName || '');
      body.appendChild(meta);
    }

    item.addEventListener('click', (e) => {
      if (e.target.closest('.note-del')) return;
      jumpToNote(n);
    });
    item.querySelector('.note-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      state.notes.notes = state.notes.notes.filter((x) => x.id !== n.id);
      await writeMetaJson('notes.json', state.notes);
      if (n.imageFile) await deleteNoteImage(n.imageFile);
      renderNotesForCurrentLesson();
      renderNoteMarkers();
      if (!document.getElementById('allNotesModal').hidden) renderAllNotes();
    });
    return item;
  }

  function jumpToNote(n) {
    const found = findLessonById(n.lessonId);
    if (!found) return;
    if (!state.currentLesson || state.currentLesson.id !== n.lessonId) {
      loadLesson(found.chapter, found.lesson, true);
      video.addEventListener('loadedmetadata', function onceSeek() {
        video.currentTime = n.timestamp;
        video.removeEventListener('loadedmetadata', onceSeek);
      });
    } else {
      video.currentTime = n.timestamp;
    }
    player.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // =====================================================================
  // ALL NOTES MODAL
  // =====================================================================
  const allNotesBtn = document.getElementById('allNotesBtn');
  const allNotesModal = document.getElementById('allNotesModal');
  const allNotesBody = document.getElementById('allNotesBody');
  const closeAllNotesBtn = document.getElementById('closeAllNotesBtn');

  allNotesBtn.addEventListener('click', () => { video.pause(); renderAllNotes(); allNotesModal.hidden = false; });
  closeAllNotesBtn.addEventListener('click', () => (allNotesModal.hidden = true));
  allNotesModal.addEventListener('click', (e) => { if (e.target === allNotesModal) allNotesModal.hidden = true; });

  function renderAllNotes() {
    allNotesBody.innerHTML = '';
    if (!state.notes.notes.length) {
      allNotesBody.innerHTML = '<div class="notes-empty">You haven\'t taken any notes yet.</div>';
      return;
    }
    const chapterOrder = state.manifest ? state.manifest.chapters.map((c) => c.id) : [];
    const lessonOrder = state.manifest ? allVideosFlat().map((v) => v.id) : [];
    const byChapter = {};
    for (const n of state.notes.notes) (byChapter[n.chapterId] = byChapter[n.chapterId] || []).push(n);

    Object.keys(byChapter)
      .sort((a, b) => chapterOrder.indexOf(a) - chapterOrder.indexOf(b))
      .forEach((chapterId) => {
        const notes = byChapter[chapterId];
        const group = document.createElement('div');
        group.className = 'modal-chapter-group';
        const title = document.createElement('div');
        title.className = 'modal-chapter-title';
        title.textContent = notes[0].chapterName;
        group.appendChild(title);

        // group again by video within the chapter, so it's clear which
        // specific lesson each note belongs to, not just the chapter
        const byLesson = {};
        for (const n of notes) (byLesson[n.lessonId] = byLesson[n.lessonId] || []).push(n);

        Object.keys(byLesson)
          .sort((a, b) => lessonOrder.indexOf(a) - lessonOrder.indexOf(b))
          .forEach((lessonId) => {
            const lessonNotes = byLesson[lessonId];
            const lessonGroup = document.createElement('div');
            lessonGroup.className = 'modal-lesson-group';
            const lessonTitle = document.createElement('div');
            lessonTitle.className = 'modal-lesson-title';
            lessonTitle.textContent = prettyName(lessonNotes[0].lessonName || '');
            lessonGroup.appendChild(lessonTitle);

            lessonNotes
              .sort((a, b) => a.timestamp - b.timestamp)
              .forEach((n) => {
                const item = buildNoteItem(n, false);
                item.addEventListener('click', (e) => {
                  if (!e.target.closest('.note-del')) allNotesModal.hidden = true;
                });
                lessonGroup.appendChild(item);
              });
            group.appendChild(lessonGroup);
          });
        allNotesBody.appendChild(group);
      });
  }

  // =====================================================================
  // AUTOSAVE
  // =====================================================================
  const saveBtn = document.getElementById('saveBtn');
  const saveLabel = document.getElementById('saveLabel');

  function markDirty() { dirty = true; }

  // Save feedback lives entirely inside the Save button — spinner while
  // writing, a brief check when done, then back to idle. No toast.
  let saveStateTimer = null;
  let saving = false;
  function setSaveState(s) {
    saveBtn.dataset.state = s;
    saveLabel.textContent = s === 'saving' ? 'Saving' : s === 'saved' ? 'Saved' : 'Save';
    clearTimeout(saveStateTimer);
    if (s === 'saved') saveStateTimer = setTimeout(() => setSaveState('idle'), 1400);
  }

  async function saveNow() {
    if (!state.manifest || saving) return;
    saving = true;
    setSaveState('saving');
    const startedAt = Date.now();
    try {
      await writeMetaJson('progress.json', state.progress);
      await writeMetaJson('preferences.json', state.prefs);
      dirty = false;
      // local writes finish in a few ms; hold the spinner briefly so the
      // state change reads as deliberate rather than a flicker
      const wait = Math.max(0, 320 - (Date.now() - startedAt));
      setTimeout(() => setSaveState('saved'), wait);
    } catch {
      setSaveState('idle');
    } finally {
      saving = false;
    }
  }
  saveBtn.addEventListener('click', saveNow);

  setInterval(() => { if (dirty) saveNow(); }, 15000);
  setInterval(() => { if (state.manifest) saveNow(); }, 60000);

  // best-effort only -- unlike the old server's sendBeacon, a File System
  // Access write is async and the browser can still tear the page down
  // before it finishes. The 15s/60s interval above is the real safety net.
  document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) saveNow(); });
  window.addEventListener('pagehide', () => { if (dirty) saveNow(); });

  init();
})();
