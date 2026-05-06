(() => {
  const fileInput = document.getElementById('fileInput');
  const addMoreInput = document.getElementById('addMoreInput');
  const uploadScreen = document.getElementById('uploadScreen');
  const playerScreen = document.getElementById('playerScreen');
  const audio = document.getElementById('audio');
  const trackTitle = document.getElementById('trackTitle');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const seek = document.getElementById('seek');
  const currentTimeEl = document.getElementById('currentTime');
  const durationEl = document.getElementById('duration');
  const volume = document.getElementById('volume');
  const changeBtn = document.getElementById('changeBtn');
  const canvas = document.getElementById('visualizer');
  const ctx = canvas.getContext('2d');
  const playlistEl = document.getElementById('playlist');
  const playlistCountEl = document.getElementById('playlistCount');
  const playlistEmpty = document.getElementById('playlistEmpty');

  let audioCtx, analyser, source, dataArray, rafId;
  let currentURL = null;
  let tracks = []; // [{id, name, type, blob}]
  let currentId = null;

  // ===== IndexedDB =====
  const DB_NAME = 'cozy-music-db';
  const STORE = 'tracks';
  const META = 'meta';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Recreate tracks store with autoIncrement (legacy v1/v2 had no keyPath)
        if (db.objectStoreNames.contains(STORE)) {
          db.deleteObjectStore(STORE);
        }
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbAddTrack(file) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add({ name: file.name, type: file.type, blob: file });
      req.onsuccess = () => { const id = req.result; tx.oncomplete = () => { db.close(); resolve(id); }; };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }
  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }
  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => { db.close(); resolve(); };
    });
  }
  async function dbClearAll() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(META).clear();
      tx.oncomplete = () => { db.close(); resolve(); };
    });
  }
  async function dbSetCurrent(id) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(META, 'readwrite');
      tx.objectStore(META).put(id, 'currentId');
      tx.oncomplete = () => { db.close(); resolve(); };
    });
  }
  async function dbGetCurrent() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(META, 'readonly');
      const req = tx.objectStore(META).get('currentId');
      req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  }

  const fmt = (s) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  function setupAudioContext() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);

  function draw() {
    rafId = requestAnimationFrame(draw);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);
    const bars = dataArray.length;
    const gap = 3;
    const barW = (w - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      const v = dataArray[i] / 255;
      const barH = Math.max(2, v * h * 0.95);
      const x = i * (barW + gap);
      const y = h - barH;
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, '#ffb4a2');
      grad.addColorStop(1, '#f4a7c0');
      ctx.fillStyle = grad;
      const r = Math.min(barW / 2, 4);
      roundRect(ctx, x, y, barW, barH, r);
      ctx.fill();
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h);
    c.lineTo(x, y + h);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  // ===== Playlist UI =====
  const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  function stripExt(name){ return (name || 'Untitled').replace(/\.[^.]+$/, ''); }

  function renderPlaylist() {
    playlistEl.innerHTML = '';
    playlistCountEl.textContent = tracks.length;
    if (tracks.length === 0) {
      playlistEmpty.classList.remove('hidden');
      return;
    }
    playlistEmpty.classList.add('hidden');
    tracks.forEach((t) => {
      const li = document.createElement('li');
      li.className = 'pl-item' + (t.id === currentId ? ' active' : '');
      li.dataset.id = t.id;

      const title = document.createElement('span');
      title.className = 'pl-title';
      title.textContent = stripExt(t.name);
      title.title = t.name;

      const btn = document.createElement('button');
      btn.className = 'pl-btn';
      btn.setAttribute('aria-label', 'Play / Pause');
      const isCurrent = t.id === currentId;
      const isPlaying = isCurrent && !audio.paused;
      btn.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
      btn.addEventListener('click', () => onPlaylistBtn(t.id));

      const del = document.createElement('button');
      del.className = 'pl-del';
      del.setAttribute('aria-label', 'Remove');
      del.textContent = '×';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(t.id); });

      li.appendChild(title);
      li.appendChild(btn);
      li.appendChild(del);
      playlistEl.appendChild(li);
    });
  }

  function updatePlaylistButtons() {
    const items = playlistEl.querySelectorAll('.pl-item');
    items.forEach((li) => {
      const id = Number(li.dataset.id);
      const btn = li.querySelector('.pl-btn');
      li.classList.toggle('active', id === currentId);
      const isPlaying = id === currentId && !audio.paused;
      btn.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
    });
  }

  async function onPlaylistBtn(id) {
    if (id === currentId) {
      if (audio.paused) audio.play().catch(()=>{});
      else audio.pause();
    } else {
      const t = tracks.find((x) => x.id === id);
      if (t) playTrack(t, true);
    }
  }

  function playTrack(track, autoplay) {
    if (currentURL) URL.revokeObjectURL(currentURL);
    currentURL = URL.createObjectURL(track.blob);
    audio.src = currentURL;
    trackTitle.textContent = stripExt(track.name);
    currentId = track.id;
    dbSetCurrent(track.id);
    requestAnimationFrame(() => {
      resizeCanvas();
      if (autoplay) audio.play().catch(()=>{});
    });
    updatePlaylistButtons();
  }

  function showPlayer() {
    uploadScreen.classList.add('hidden');
    playerScreen.classList.remove('hidden');
  }

  async function addFile(file, { autoplay = true } = {}) {
    if (!file || !file.type.startsWith('audio/')) {
      alert('Please select a valid audio file.');
      return;
    }
    const id = await dbAddTrack(file);
    const track = { id, name: file.name, type: file.type, blob: file };
    tracks.push(track);
    showPlayer();
    if (autoplay || currentId == null) {
      playTrack(track, autoplay);
    }
    renderPlaylist();
  }

  async function removeTrack(id) {
    await dbDelete(id);
    tracks = tracks.filter((t) => t.id !== id);
    if (id === currentId) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      currentId = null;
      trackTitle.textContent = 'Untitled Track';
      await dbSetCurrent(null);
      if (tracks.length > 0) {
        playTrack(tracks[0], false);
      } else {
        playerScreen.classList.add('hidden');
        uploadScreen.classList.remove('hidden');
      }
    }
    renderPlaylist();
  }

  // ===== Events =====
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) addFile(f, { autoplay: true });
    fileInput.value = '';
  });
  addMoreInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) addFile(f, { autoplay: false });
    addMoreInput.value = '';
  });

  changeBtn.addEventListener('click', async () => {
    if (!confirm('Hapus semua audio dan reset?')) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    tracks = [];
    currentId = null;
    await dbClearAll();
    renderPlaylist();
    playerScreen.classList.add('hidden');
    uploadScreen.classList.remove('hidden');
  });

  playBtn.addEventListener('click', () => {
    if (!audio.src) return;
    if (audio.paused) audio.play();
    else audio.pause();
  });

  prevBtn.addEventListener('click', () => { audio.currentTime = 0; });
  nextBtn.addEventListener('click', () => {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
  });

  audio.addEventListener('play', () => {
    setupAudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
    if (!rafId) draw();
    updatePlaylistButtons();
  });
  audio.addEventListener('pause', () => {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    updatePlaylistButtons();
  });
  audio.addEventListener('ended', () => {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    updatePlaylistButtons();
  });

  audio.addEventListener('loadedmetadata', () => {
    durationEl.textContent = fmt(audio.duration);
    seek.max = audio.duration;
  });
  audio.addEventListener('timeupdate', () => {
    currentTimeEl.textContent = fmt(audio.currentTime);
    if (!seek.dragging) seek.value = audio.currentTime;
  });
  seek.addEventListener('input', () => { seek.dragging = true; });
  seek.addEventListener('change', () => {
    audio.currentTime = seek.value;
    seek.dragging = false;
  });

  volume.addEventListener('input', () => { audio.volume = volume.value; });
  audio.volume = volume.value;

  // ===== Restore =====
  (async () => {
    try {
      const all = await dbGetAll();
      tracks = all.map((r) => ({ id: r.id, name: r.name, type: r.type, blob: r.blob }));
      if (tracks.length > 0) {
        const savedId = await dbGetCurrent();
        const t = tracks.find((x) => x.id === savedId) || tracks[0];
        showPlayer();
        playTrack(t, false); // autoplay blocked on load
      }
      renderPlaylist();
    } catch (e) {
      console.warn('Restore failed:', e);
    }
  })();

  // ===== Background Video Lazy Load (4K Optimized) =====
(function initBackgroundVideo(){
  const video = document.querySelector('.bg-video')
  if (!video) return

  // tampilkan poster dulu, jangan load video
  let loaded = false

  function loadVideo(){
    if (loaded) return
    loaded = true

    // inject source (baru mulai download di sini)
    video.innerHTML = `
      <source src="assets/videos/HATSUNE MIKU 4K.webm" type="video/webm">
    `

    video.load()

    // coba autoplay (akan berhasil karena muted)
    video.play().catch(() => {})
  }

  // ✅ Strategi 1: tunggu UI siap dulu
  window.addEventListener('load', () => {
    setTimeout(loadVideo, 1200) // delay biar UI & font render dulu
  })

  // ✅ Strategi 2: fallback kalau user interaksi lebih cepat
  document.addEventListener('click', loadVideo, { once: true })
  document.addEventListener('scroll', loadVideo, { once: true })
})()
})();
