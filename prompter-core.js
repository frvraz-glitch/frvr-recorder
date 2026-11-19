// The FRVR teleprompter engine. No app imports: the Forever app (js/views/prompter.js) and the standalone recorder
// (recorder/index.html) both run this one file.
//   spokenLines(script) · pulls what Aziel actually says out of a piece's script (SAY / VO lines, or plain paragraphs)
//   mountPrompter(root, opts) · full-screen prompter over the live front camera, or over black when there is no camera
// Speed is words per minute, measured against the laid-out text, so changing the text size never changes his pace.
// The words sit on the screen only: the recording holds the camera and mic, never the text.

export const DEFAULTS = { size: 38, wpm: 130, mirror: false, width: 100 };
export const LIMITS = { size: [20, 84], wpm: [60, 240] };
const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// One piece's script → [{ kind: 'head' | 'say' | 'yours' | 'cue', text }]
//   say   · words to read
//   yours · a line only Aziel can give ([AZ: …]): shown as a gold prompt, never filled in for him
//   cue   · a stage direction in brackets, shown small and dim
export function spokenLines(script = '') {
  const raw = String(script).replace(/\r/g, '').split('\n');
  const SAY = /^\s*(?:SAY|VO(?:\s*\d+)?|V\.?O\.?)\b\s*(\[[^\]]*\]|\([^)]*\))?\s*:\s*(.*)$/i;
  const HEAD = /^\s*\[\s*\d[^\]]*\]\s*(.*)$/;
  const hasSay = raw.some(l => SAY.test(l));
  // Long-form scripts are an outline: "03:30 WHAT HE ASKS" over "• …" bullets, which he talks from.
  const CHAPTER = /^\s*\d{1,2}:\d{2}\s+(.+)$/, BULLET = /^\s*[•*-]\s+(.*)$/;
  const out = [];
  const pushSay = text => {
    const parts = String(text).split(/(\[[^\]]*\]|\([^)]*\))/).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const az = p.match(/^\[\s*AZ\s*:?\s*(.*)\]$/i);
      if (az) out.push({ kind: 'yours', text: az[1] || 'Your words' });
      else if (/^[[(]/.test(p)) out.push({ kind: 'cue', text: p.replace(/^[[(]|[\])]$/g, '') });
      else { const t = p.replace(/^["“]|["”]$/g, '').trim(); if (t) out.push({ kind: 'say', text: t }); }
    }
  };
  if (!hasSay && raw.some(l => CHAPTER.test(l))) {
    let inBody = false;
    for (const l of raw) {
      const h = l.match(CHAPTER); if (h) { inBody = true; out.push({ kind: 'head', text: h[1].replace(/←.*$/, '').trim() }); continue; }
      const b = l.match(BULLET); if (inBody && b) pushSay(b[1]);
    }
    return out;
  }
  if (!hasSay) {
    raw.join('\n').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).forEach(p => pushSay(p.replace(/\n/g, ' ')));
    return out;
  }
  let pending = '';
  for (const l of raw) {
    const h = l.match(HEAD); if (h) { pending = h[1].replace(/\(.*?\)/g, '').trim(); continue; }
    const m = l.match(SAY); if (!m) continue;
    if (pending) { out.push({ kind: 'head', text: pending }); pending = ''; }
    pushSay(m[2]);
  }
  return out;
}
export const plainText = lines => lines.map(l => l.kind === 'say' ? l.text : l.kind === 'yours' ? `[AZ: ${l.text}]` : l.kind === 'cue' ? `(${l.text})` : `\n# ${l.text}`).join('\n').trim();
export function parsePlain(text = '') {
  const out = [];
  for (const b of String(text).split('\n')) { const t = b.trim(); if (!t) continue; if (t.startsWith('# ')) out.push({ kind: 'head', text: t.slice(2) }); else out.push(...spokenLines(t)); }
  return out;
}
export const wordCount = lines => lines.filter(l => l.kind === 'say').reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
export const fmtTime = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const slug = s => String(s || 'take').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'take';
// frvr-record's filename, so a take lands in the right place without renaming.
export const takeName = (title, n, ext, code = 'A', d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${slug(title)}_${code}_t${n}.${ext}`;

const MIMES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
const pickMime = () => (window.MediaRecorder ? MIMES.find(m => MediaRecorder.isTypeSupported(m)) : '') || '';
export const canRecordHere = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

// Opens the front camera. Rejects with the browser's error when the page isn't allowed to.
export async function openCamera(landscape = innerWidth > innerHeight) {
  const video = { facingMode: 'user', width: { ideal: landscape ? 1920 : 1080 }, height: { ideal: landscape ? 1080 : 1920 }, frameRate: { ideal: 30 } };
  const audio = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
  try { return await navigator.mediaDevices.getUserMedia({ video, audio }); }
  catch (e) { if (e.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true }); throw e; }
}

export const PROMPTER_CSS = `
.pt{position:fixed;inset:0;z-index:9999;background:#05060c;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}
.pt video.pt-cam{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);background:#05060c}
.pt .pt-shade{position:absolute;inset:0 0 auto 0;height:58%;background:linear-gradient(to bottom,rgba(5,6,12,.86) 0,rgba(5,6,12,.74) 72%,rgba(5,6,12,0) 100%);pointer-events:none}
.pt.pt-nocam .pt-shade{display:none}
.pt .pt-view{position:absolute;left:0;right:0;top:0;height:58%;overflow:hidden;padding:0 max(18px,env(safe-area-inset-left));cursor:grab}
.pt.pt-nocam .pt-view{height:calc(100% - 232px)}
.pt.pt-sheeted .pt-top{display:none}
.pt .pt-roll{will-change:transform;padding-bottom:60vh;margin:0 auto;max-width:900px}
.pt.pt-mirror .pt-roll{transform-origin:center}
.pt .pt-say{font-family:'Inter Tight','Inter',-apple-system,sans-serif;font-weight:600;line-height:1.28;margin:0 0 .62em;letter-spacing:-.005em;overflow-wrap:break-word}
.pt .pt-say.pt-yours{color:#E0B84F;font-style:italic;font-weight:500}
.pt .pt-say.pt-yours::before{content:'YOUR WORDS';display:block;font:600 11px/1.6 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;font-style:normal}
.pt .pt-head{font:600 12px/1.5 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.46);margin:1.6em 0 .7em}
.pt .pt-cue{font-size:.46em;line-height:1.4;color:rgba(255,255,255,.52);margin:0 0 1em}
.pt .pt-mark{position:absolute;left:0;width:10px;height:0;border:7px solid transparent;border-left:9px solid #E0B84F;width:0;margin-top:-7px;pointer-events:none}
.pt .pt-bar{position:absolute;left:0;right:0;bottom:0;padding:10px 14px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(to top,rgba(5,6,12,.92) 62%,rgba(5,6,12,0));display:grid;gap:8px;touch-action:manipulation}
.pt .pt-ctl{display:grid;grid-template-columns:44px 1fr 44px;gap:8px;align-items:center;max-width:560px;width:100%;margin:0 auto}
.pt .pt-ctl label{display:flex;flex-direction:column;gap:3px;font:500 11px/1.2 'JetBrains Mono',ui-monospace,monospace;color:rgba(255,255,255,.72);letter-spacing:.04em;text-align:center}
.pt .pt-ctl b{color:#fff;font-weight:600}
.pt input[type=range]{width:100%;height:28px;margin:0;accent-color:#E0B84F;background:transparent}
.pt button{font:inherit;color:#fff;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);border-radius:12px;min-height:44px;min-width:44px;cursor:pointer;touch-action:manipulation}
.pt button:active{background:rgba(255,255,255,.22)}
.pt .pt-ctl button{font-size:20px;line-height:1}
.pt .pt-main{display:flex;align-items:center;justify-content:center;gap:12px;max-width:560px;width:100%;margin:0 auto}
.pt .pt-main .pt-side{flex:1;padding:0 6px;font-size:13px}
.pt .pt-main .pt-side.pt-on{color:#E0B84F;border-color:#E0B84F}
.pt .pt-rec{width:68px;height:68px;min-height:68px;border-radius:50%;background:transparent;border:4px solid #fff;display:grid;place-items:center;flex:none;padding:0}
.pt .pt-rec i{display:block;width:52px;height:52px;border-radius:50%;background:#ef3b3b;transition:all .18s}
.pt .pt-rec.pt-on i{width:26px;height:26px;border-radius:6px}
.pt .pt-rec.pt-play i{background:#E0B84F;width:0;height:0;border-radius:0;background:none;border-left:24px solid #E0B84F;border-top:15px solid transparent;border-bottom:15px solid transparent;margin-left:6px}
.pt .pt-rec.pt-play.pt-on i{width:24px;height:26px;border:0;margin:0;background:linear-gradient(to right,#E0B84F 0 8px,transparent 8px 16px,#E0B84F 16px)}
.pt .pt-top{position:absolute;right:max(10px,env(safe-area-inset-right));top:max(10px,env(safe-area-inset-top));display:flex;gap:8px;align-items:center;z-index:3}
.pt .pt-top button{min-height:38px;min-width:38px;background:rgba(5,6,12,.62);padding:0 10px;font-size:14px}
.pt .pt-stat{position:absolute;left:max(12px,env(safe-area-inset-left));top:max(14px,env(safe-area-inset-top));z-index:3;font:600 12px/1 'JetBrains Mono',ui-monospace,monospace;background:rgba(5,6,12,.62);padding:7px 9px;border-radius:9px;display:flex;gap:8px;align-items:center}
.pt .pt-stat.pt-live{color:#fff;background:#d42b2b}
.pt .pt-count{position:absolute;inset:0;display:grid;place-items:center;font:700 140px/1 'Inter Tight',sans-serif;color:#fff;text-shadow:0 4px 40px rgba(0,0,0,.8);pointer-events:none;z-index:4}
.pt .pt-sheet{position:absolute;inset:auto 0 0 0;background:#12152A;border-radius:20px 20px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));max-height:80%;overflow:auto;z-index:5;touch-action:pan-y;user-select:text;-webkit-user-select:text}
.pt .pt-sheet h3{margin:0 0 4px;font:600 17px/1.3 'Inter Tight',sans-serif}
.pt .pt-sheet p{margin:0 0 12px;font-size:13px;color:rgba(255,255,255,.66);overflow-wrap:anywhere}
.pt .pt-sheet video{width:100%;max-height:44vh;border-radius:12px;background:#000;display:block;margin:0 0 12px}
.pt .pt-sheet .pt-acts{display:grid;gap:8px}
.pt .pt-sheet .pt-acts button{padding:0 14px;font-weight:600}
.pt .pt-sheet .pt-acts .pt-go{background:#E0B84F;border-color:#E0B84F;color:#0E1020}
@media (orientation:landscape) and (max-height:520px){.pt .pt-view{height:66%}.pt .pt-bar{grid-template-columns:1fr auto 1fr;align-items:center;padding-top:4px}.pt .pt-ctl{grid-column:auto}.pt .pt-rec{width:56px;height:56px;min-height:56px}.pt .pt-rec i{width:42px;height:42px}}
`;
function injectCSS() { if (document.getElementById('pt-css')) return; const s = document.createElement('style'); s.id = 'pt-css'; s.textContent = PROMPTER_CSS; document.head.appendChild(s); }

// opts: { lines, title, stream (null = no camera), prefs, onPrefs(prefs), onTake(file, n) → may return actions, onClose(), takeStart }
export function mountPrompter(root, opts) {
  injectCSS();
  const { lines, title, stream, onPrefs, onTake, onClose } = opts;
  const prefs = { ...DEFAULTS, ...(opts.prefs || {}) };
  const words = wordCount(lines);
  const el = document.createElement('div');
  el.className = `pt ${stream ? '' : 'pt-nocam'} ${prefs.mirror ? 'pt-mirror' : ''}`;
  el.innerHTML = `${stream ? '<video class="pt-cam" playsinline autoplay muted></video><div class="pt-shade"></div>' : ''}
    <div class="pt-view"><div class="pt-roll">${lines.map(l => l.kind === 'head' ? `<p class="pt-head">${esc(l.text)}</p>` : `<p class="pt-say ${l.kind === 'yours' ? 'pt-yours' : ''} ${l.kind === 'cue' ? 'pt-cue' : ''}">${esc(l.text)}</p>`).join('')}</div></div>
    <div class="pt-stat" data-stat></div>
    <div class="pt-top"><button data-mirror title="Flip the words for a glass rig">⇋</button><button data-close aria-label="Close">✕</button></div>
    <div class="pt-bar">
      <div class="pt-ctl"><button data-size="-1" aria-label="Smaller text">A−</button><label>TEXT SIZE <b data-sizev></b><input type="range" data-sizer min="${LIMITS.size[0]}" max="${LIMITS.size[1]}" step="1" aria-label="Text size"></label><button data-size="1" aria-label="Larger text">A+</button></div>
      <div class="pt-ctl"><button data-wpm="-5" aria-label="Slower">🐢</button><label>SPEED <b data-wpmv></b><input type="range" data-wpmr min="${LIMITS.wpm[0]}" max="${LIMITS.wpm[1]}" step="5" aria-label="Speed in words per minute"></label><button data-wpm="5" aria-label="Faster">🐇</button></div>
      <div class="pt-main"><button class="pt-side" data-top>↑ To the top</button><button class="pt-rec ${stream ? '' : 'pt-play'}" data-main aria-label="${stream ? 'Record' : 'Play'}"><i></i></button><button class="pt-side" data-pause></button></div>
    </div>`;
  root.appendChild(el);
  const $ = q => el.querySelector(q);
  const view = $('.pt-view'), roll = $('.pt-roll'), statEl = $('[data-stat]');
  const video = $('video.pt-cam'); if (video) { video.srcObject = stream; video.play?.().catch(() => {}); }

  let y = 0, running = false, recording = false, raf = 0, last = 0, recStart = 0, recorder = null, chunks = [], takeN = opts.takeStart || 1, lock = null, hold = 0, busy = false, lastStat = 0;
  const mark = document.createElement('div'); mark.className = 'pt-mark'; view.appendChild(mark);
  const readLine = () => Math.round(view.clientHeight * 0.22);
  const scrollable = () => Math.max(1, roll.scrollHeight - innerHeight * 0.6);          // the text's own height, without the tail padding
  const pxPerWord = () => scrollable() / Math.max(1, words);
  const apply = () => { const s = prefs.mirror ? 'scaleX(-1) ' : ''; roll.style.transform = `${s}translate3d(0,${readLine() - y}px,0)`; mark.style.top = readLine() + 'px'; };
  const remain = () => (Math.max(0, scrollable() - y) / pxPerWord()) / (prefs.wpm / 60);
  const stat = () => { statEl.classList.toggle('pt-live', recording); statEl.textContent = recording ? `● ${fmtTime((performance.now() - recStart) / 1000)}` : `${words} words · ${fmtTime(remain())} left`; };
  const persist = () => onPrefs?.({ ...prefs });
  const paint = () => {
    roll.style.fontSize = prefs.size + 'px';
    $('[data-sizev]').textContent = prefs.size; $('[data-sizer]').value = prefs.size;
    $('[data-wpmv]').textContent = `${prefs.wpm} wpm`; $('[data-wpmr]').value = prefs.wpm;
    el.classList.toggle('pt-mirror', !!prefs.mirror); $('[data-mirror]').classList.toggle('pt-on', !!prefs.mirror); stat(); apply();
  };
  // A new size re-flows the text; keep the same words on the reading line.
  const setSize = v => { const frac = y / scrollable(); prefs.size = clamp(v, LIMITS.size); roll.style.fontSize = prefs.size + 'px'; y = frac * scrollable(); paint(); persist(); };
  const setWpm = v => { prefs.wpm = clamp(v, LIMITS.wpm); paint(); persist(); };

  const tick = t => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    if (running && t > hold) { y += pxPerWord() * (prefs.wpm / 60) * dt; if (y >= scrollable()) { y = scrollable(); setRunning(false); } apply(); }
    if (t - lastStat > 250) { lastStat = t; stat(); }
  };
  const setRunning = v => {
    running = v; last = performance.now();
    $('[data-pause]').textContent = stream ? (running ? 'Pause words' : 'Resume words') : (running ? 'Pause' : 'Play');
    if (!stream) { const b = $('[data-main]'); b.classList.toggle('pt-on', running); b.setAttribute('aria-label', running ? 'Pause' : 'Play'); }
  };
  const keepAwake = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; } };
  const onVis = () => { if (document.visibilityState === 'visible') keepAwake(); else if (recording) stopRec(); };
  document.addEventListener('visibilitychange', onVis);

  // ---------- recording ----------
  const countdown = async n => { const c = document.createElement('div'); c.className = 'pt-count'; el.appendChild(c); for (let i = n; i > 0; i--) { c.textContent = i; await new Promise(r => setTimeout(r, 800)); } c.remove(); };
  async function startRec() {
    if (busy) return; busy = true;
    await countdown(3);
    chunks = []; const mimeType = pickMime();
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = finishRec;
    recorder.start(1000); recStart = performance.now(); recording = true; busy = false;
    $('[data-main]').classList.add('pt-on'); $('[data-main]').setAttribute('aria-label', 'Stop');
    setRunning(true); stat();
  }
  function stopRec() { if (!recorder || recorder.state === 'inactive') return; recording = false; setRunning(false); $('[data-main]').classList.remove('pt-on'); $('[data-main]').setAttribute('aria-label', 'Record'); stat(); recorder.stop(); }
  function finishRec() {
    const type = (recorder.mimeType || 'video/mp4').split(';')[0]; const ext = type.includes('webm') ? 'webm' : 'mp4';
    const blob = new Blob(chunks, { type }); const name = takeName(title, takeN, ext);
    const file = new File([blob], name, { type }); const n = takeN++; chunks = [];
    showTake(file, n);
  }
  function showTake(file, n) {
    const url = URL.createObjectURL(file); const mb = (file.size / 1048576).toFixed(0);
    const sh = document.createElement('div'); sh.className = 'pt-sheet';
    sh.innerHTML = `<h3>Take ${n}</h3><p>${esc(file.name)} · ${mb} MB</p><video src="${url}" controls playsinline></video><div class="pt-acts"></div>`;
    el.appendChild(sh);
    const acts = sh.querySelector('.pt-acts');
    const add = (label, fn, go) => { const b = document.createElement('button'); b.textContent = label; if (go) b.className = 'pt-go'; b.onclick = () => fn(b); acts.appendChild(b); };
    // ✕ hides while a take is showing, and leaving an unsaved take takes a second tap: a take is never lost by accident.
    let kept = false; el.classList.add('pt-sheeted');
    const close = () => { URL.revokeObjectURL(url); sh.remove(); el.classList.remove('pt-sheeted'); y = 0; apply(); stat(); };
    (onTake?.(file, n) || []).forEach(a => add(a.label, async b => { const r = await a.run(b, close); if (r !== false) kept = true; }, a.go));
    const leave = (label, warn) => add(label, b => { if (kept || b.dataset.sure) return close(); b.dataset.sure = '1'; b.textContent = warn; });
    leave('↺ Another take', 'Not saved yet. Tap again to leave it');
    leave('🗑 Discard this take', 'Tap again to discard');
  }

  // ---------- controls ----------
  $('[data-main]').onclick = () => { if (!stream) return setRunning(!running); recording ? stopRec() : startRec(); };
  $('[data-pause]').onclick = () => setRunning(!running);
  $('[data-top]').onclick = () => { y = 0; hold = performance.now() + 800; apply(); stat(); };
  $('[data-mirror]').onclick = () => { prefs.mirror = !prefs.mirror; paint(); persist(); };
  $('[data-sizer]').oninput = e => setSize(+e.target.value);
  $('[data-wpmr]').oninput = e => setWpm(+e.target.value);
  el.querySelectorAll('[data-size]').forEach(b => b.onclick = () => setSize(prefs.size + 2 * +b.dataset.size));
  el.querySelectorAll('[data-wpm]').forEach(b => b.onclick = () => setWpm(prefs.wpm + +b.dataset.wpm));
  // Tap the words to pause or carry on; drag to find your place.
  let drag = null;
  view.onpointerdown = e => { drag = { py: e.clientY, y, moved: false, was: running }; view.setPointerCapture(e.pointerId); };
  view.onpointermove = e => { if (!drag) return; const d = drag.py - e.clientY; if (Math.abs(d) > 6) { if (!drag.moved) { drag.moved = true; running = false; } y = Math.min(scrollable(), Math.max(0, drag.y + d)); apply(); stat(); } };
  view.onpointerup = () => { if (!drag) return; const { moved, was } = drag; drag = null; if (moved) { setRunning(was); hold = performance.now() + 500; } else setRunning(!running); };
  view.onpointercancel = () => { drag = null; };
  const onKey = e => {
    if (e.target?.tagName === 'INPUT' && e.target.type !== 'range') return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); setRunning(!running); }
    else if (k === 'ArrowUp') { e.preventDefault(); setWpm(prefs.wpm + 5); }
    else if (k === 'ArrowDown') { e.preventDefault(); setWpm(prefs.wpm - 5); }
    else if (k === '=' || k === '+') setSize(prefs.size + 2);
    else if (k === '-') setSize(prefs.size - 2);
    else if (k === 'r' && stream) $('[data-main]').click();
    else if (k === 'Escape') close();
  };
  addEventListener('keydown', onKey);
  const onResize = () => { apply(); stat(); }; addEventListener('resize', onResize);
  const guard = e => { if (recording) { e.preventDefault(); e.returnValue = ''; } }; addEventListener('beforeunload', guard);
  function close() {
    if (recording) return stopRec();   // Never lose a take: ✕ while recording stops it and shows the take first.
    cancelAnimationFrame(raf); lock?.release?.().catch?.(() => {}); document.removeEventListener('visibilitychange', onVis); removeEventListener('keydown', onKey); removeEventListener('resize', onResize); removeEventListener('beforeunload', guard);
    stream?.getTracks().forEach(t => t.stop()); el.remove(); onClose?.();
  }
  $('[data-close]').onclick = close;
  keepAwake(); paint(); setRunning(false); last = performance.now(); raf = requestAnimationFrame(tick);
  document.fonts?.ready?.then(() => { apply(); stat(); });
  return { close, el };
}

// The app hands a script to the recorder in the URL's hash, which browsers never send to the server.
export const encodeHand = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const decodeHand = s => JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')))));
