/* =====================================================================
 *  api.js — 서버(GAS) 통신 + 재시도 큐(outbox)
 *  · 네트워크 실패 시 명령을 큐에 보관하고 지수 백오프로 재시도
 *  · 서버 혼잡(busy)도 같은 방식으로 재시도 → 30명 동시 제출 병목 대응
 * ===================================================================== */
const API = (() => {
  const OUTBOX_KEY = 'studyroom_outbox';
  const SESSION_KEY = 'studyroom_session';
  let session = null;        // { token, id, name }
  let outbox = [];
  let flushing = false, backoff = 2000, timer = null;
  const listeners = [];

  function enabled() { return !!(CONFIG.gasUrl && CONFIG.gasUrl.startsWith('http')); }

  /* ---------- 세션 ---------- */
  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { session = null; }
    try { outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch (e) { outbox = []; }
    if (session && session.id) outbox = outbox.filter(j => j.id === session.id);
    return session;
  }
  function setSession(s) { session = s; localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function clearSession() { session = null; outbox = []; localStorage.removeItem(SESSION_KEY); localStorage.removeItem(OUTBOX_KEY); }
  function getSession() { return session; }

  /* ---------- 호출 ---------- */
  async function call(payload, { timeout = 25000 } = {}) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl && setTimeout(() => ctrl.abort(), timeout);
    try {
      // GAS 웹앱: text/plain 본문의 단순 요청만 CORS 없이 허용 (헤더 추가 금지)
      const res = await fetch(CONFIG.gasUrl, { method: 'POST', body: JSON.stringify(Object.assign({ token: session && session.token }, payload)), redirect: 'follow', signal: ctrl && ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data && data.error === 'busy') { const e = new Error('busy'); e.retry = true; throw e; }
      return data;
    } finally { if (t) clearTimeout(t); }
  }
  async function getTime() {
    if (!enabled()) return null;
    try { const r = await fetch(CONFIG.gasUrl + '?action=time', { redirect: 'follow' }); return r.json(); } catch (e) { return null; }
  }

  /* ---------- outbox ---------- */
  function persist() { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); }
  function notify(ev) { listeners.forEach(fn => { try { fn(ev); } catch (e) { /* ignore */ } }); }
  function onStatus(fn) { listeners.push(fn); }
  function pending() { return outbox.length; }

  function enqueue(cmd) {
    outbox.push({ id: session.id, cmd, at: Date.now() });
    persist();
    flush();
  }
  async function flush() {
    if (flushing || !session) return;
    if (!outbox.length) { notify({ type: 'idle' }); return; }
    flushing = true;
    clearTimeout(timer);
    while (outbox.length) {
      const job = outbox[0];
      try {
        const res = await call({ action: 'cmd', cmd: job.cmd });
        outbox.shift(); persist(); backoff = 2000;
        if (res.error === 'auth') { notify({ type: 'auth' }); break; }
        if (res.error === 'night_lock') { notify({ type: 'night_lock', res }); break; }
        notify({ type: res.ok ? 'done' : 'rejected', job, res, left: outbox.length });
      } catch (e) {
        notify({ type: 'retry', error: e, wait: backoff, left: outbox.length });
        timer = setTimeout(() => { flushing = false; flush(); }, backoff);
        backoff = Math.min(60000, backoff * 2);
        return;
      }
    }
    flushing = false;
    notify({ type: 'idle' });
  }
  function kick() { backoff = 2000; clearTimeout(timer); flushing = false; flush(); }

  return { enabled, loadSession, setSession, clearSession, getSession, call, getTime, enqueue, flush, kick, pending, onStatus };
})();
