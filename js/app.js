/* =====================================================================
 *  app.js — 화면 전환, 로그인, 학습 루프, 단원별 방, 친구 방, 상점, 서재, 교사
 *  · 로컬 모드 : CONFIG.gasUrl 비어 있음 → Engine 을 브라우저에서 실행, localStorage 저장(시연용)
 *  · 서버 모드 : 학번+비밀번호 로그인 → 서버(Engine)가 코인·보상·판정 결정, 교사 폴더에만 저장
 * ===================================================================== */
const STORAGE_KEY = 'studyroom_v1';
const MODE = API.enabled() ? 'server' : 'local';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');

let state = null, topics = [], units = [], currentRoomId = null, serverOffset = 0;
let coupons = CONFIG.coupons.slice();   // 서버 모드에서는 쿠폰 시트 내용으로 교체됨
let events = Engine.defaultEvents();    // 서버 모드에서는 이벤트 시트 내용으로 교체됨
let customItems = [];                     // 교사 정의 가구 (서버 아이템 시트)
function applyItems(list) { if (!list) return; customItems = list; applyCustomItems(list.map(x => Object.assign({}, x, { pool: x.sell ? x.pool : (x.pool === 'box' ? 'box' : 'none'), enabled: x.enabled && (x.sell || x.pool === 'box') }))); }
let serverSettings = { nightLockOff: false, classLock: Object.assign({}, CONFIG.classLock) };   // 교사가 앱에서 바꾸는 공개 설정
let itemPrices = {};
function applyItemPrices(m) { itemPrices = m || {}; Object.keys(ITEMS).forEach(id => { if (!ITEMS[id].custom) ITEMS[id].cost = itemPrices[id] > 0 ? Number(itemPrices[id]) : undefined; }); }
function applyPricing(p) {   // 서버에서 받은 가격·보상을 CONFIG 에 반영 (표시와 즉시 적용 계산이 서버와 같아지도록)
  if (!p) return;
  CONFIG.shopPrice = { common: p.common, rare: p.rare, epic: p.epic };
  CONFIG.recolorCost = p.recolor; CONFIG.restyleCost = p.restyle; CONFIG.wallpaperCost = p.wallpaper; ITEMS.photo_frame.cost = p.photoFrame;
  CONFIG.rewards = Object.assign({}, CONFIG.rewards, { conceptCoin: p.conceptCoin, quizCoin: p.quizCoin, passCoin: p.passCoin, firstTryBonus: p.firstTryBonus, monsterBonus: p.monsterBonus });
  CONFIG.sticker = Object.assign({}, CONFIG.sticker, { coin: p.stickerCoin });
}
let myRoom = null, visitRoom = null;
let study = { step: 'units' };
let teacherOpen = false;
let inbox = { knocks: [], stickers: [] };
let friends = { mode: 'list', list: [], target: null, view: null, roomId: null, myStickers: [] };
let pollTimer = null;

/* ---------------- 공용 ---------------- */
function todayKey(d = new Date(Date.now() + serverOffset)) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function monthKey() { return todayKey().slice(0, 7); }
function shortDate(key) { return key.slice(5).replace('-', '/'); }
function ctx() { return { topics, units, coupons, events, today: todayKey(), rng: Math.random }; }
function unitOf(id) { return units.find(u => u.id === id); }
/** 서버에 보내는 현재 위치: 학습 중이면 그 단원, 아니면 보고 있는 방 */
function whereNow() { if (!state) return ''; const st = $('#screen-study'); if (st && st.classList.contains('active') && study.unit) return study.unit.id; return currentRoomId || ''; }
function topicOf(id) { return topics.find(t => t.id === id); }
function topicCode(id) { const t = topicOf(id); return t && t.code ? t.code : ''; }
function setTopics(list) { topics = list || []; units = Engine.groupUnits(topics); }
function unitTitle(id) { const u = unitOf(id); return u ? u.title : (id === 'home' ? '내 방' : '이전 단원'); }
let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast'); el.textContent = msg; el.className = 'show ' + type;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = '', 2800);
}
function showImageModal(src, title, pending) {
  modal(`<h2>🖼️ ${esc(title || '')}</h2>${pending ? '<div class="notice">선생님 승인 전이라 흑백으로 전시돼요.</div>' : ''}<img src="${src}" alt="${esc(title || '')}" style="width:100%;border-radius:12px;border:1px solid var(--line);image-rendering:auto"><div class="btn-row"><button class="btn" id="img-close">닫기</button></div>`);
  $('#img-close').onclick = closeModal;
}
function modal(html) { $('#modal-body').innerHTML = html; $('#overlay-modal').classList.remove('hidden'); }
function closeModal() { $('#overlay-modal').classList.add('hidden'); }
function updateHeader() {
  if (!state) return;
  $('#coin-display').textContent = isTeacher() ? '🪙 ∞' : `🪙 ${state.coins}`;
  $('#user-display').textContent = isTeacher() ? `👩‍🏫 ${state.student.name}` : (state.student ? `${state.student.name} (${state.student.id})` : '');
  const act = Engine.activeEvents(state, todayKey(), events);
  $('#event-badge').classList.toggle('hidden', !act.length);
  if (act.length) $('#event-badge').textContent = '🎉 ' + act.map(e => e.name).join(' · ');
}
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
  ({ room: renderRoom, study: renderStudy, library: renderLibrary, friends: renderFriends, shop: renderShop, teacher: renderTeacher })[name]();
  window.scrollTo(0, 0);
}

/* ---------------- 저장 / 명령 전달 ---------------- */
function saveLocal() { if (MODE === 'local') localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); updateHeader(); }
function handleServerError(r) {
  if (r.error === 'night_lock') { $('#overlay-lock').classList.remove('hidden'); return; }
  if (r.error === 'auth') { toast('다시 로그인해 주세요', 'bad'); logout(); return; }
  toast(r.message || r.error || '오류가 났어요', 'bad');
}
/** 명령 적용. interactive=true 면 서버 응답을 기다림(보상·구매 등), 아니면 즉시 적용 후 큐로 전송 */
async function dispatch(cmd, interactive = false) {
  if (MODE === 'local') {
    const r = Engine.apply(state, cmd, ctx());
    if (r.ok) saveLocal(); else toast(r.error, 'bad');
    return r;
  }
  if (interactive) {
    try {
      await API.flush();
      const r = await API.call({ action: 'cmd', cmd });
      if (r.ok) { state = Engine.migrate(r.state, units); updateHeader(); }
      else handleServerError(r);
      return r;
    } catch (e) {
      toast(e.message === 'busy' ? '지금 접속이 많아요. 잠시 후 다시 시도해 주세요' : '인터넷 연결을 확인하고 다시 시도해 주세요', 'bad');
      return { ok: false, error: 'network' };
    }
  }
  const r = Engine.apply(state, cmd, ctx());
  if (!r.ok) { toast(r.error, 'bad'); return r; }
  API.enqueue(cmd); updateHeader();
  return r;
}
async function reloadFromServer() {
  try {
    const r = await API.call({ action: 'load' });
    if (r.ok) { if (r.units) setTopics(r.units); if (r.coupons) coupons = r.coupons; if (r.events) events = r.events; if (r.settings) { serverSettings = r.settings; applyPricing(r.settings.prices); applyItemPrices(r.settings.itemPrices); } if (r.items) applyItems(r.items); state = Engine.migrate(r.state, units); inbox = r.inbox || inbox; updateHeader(); checkLocks(); refreshCurrent(); }
    else handleServerError(r);
  } catch (e) { /* 다음 기회에 */ }
}
function refreshCurrent() {
  const cur = $$('.screen').find(s => s.classList.contains('active'));
  if (cur) showScreen(cur.id.replace('screen-', ''));
}
API.onStatus(ev => {
  const pill = $('#sync-pill');
  if (ev.type === 'retry') { pill.className = 'pill err'; pill.textContent = `⏳ 저장 대기 ${ev.left}건 · ${Math.round(ev.wait / 1000)}초 후 재시도`; }
  else if (ev.type === 'idle') pill.className = 'pill hidden';
  else if (ev.type === 'done') { if (ev.left === 0 && ev.res.state) { state = Engine.migrate(ev.res.state, units); updateHeader(); } }
  else if (ev.type === 'rejected') { toast('저장되지 않은 변경이 있어요: ' + (ev.res.message || ev.res.error), 'bad'); reloadFromServer(); }
  else if (ev.type === 'auth') logout();
  else if (ev.type === 'night_lock') $('#overlay-lock').classList.remove('hidden');
});
window.addEventListener('online', () => API.kick());

/* ---------------- 시간 잠금 ---------------- */
function nowHour() { return new Date(Date.now() + serverOffset).getHours(); }
function inRange(h, s, e) { return s < e ? (h >= s && h < e) : (h >= s || h < e); }
function isTeacher() { const s = MODE === 'server' && API.getSession(); return !!(s && s.teacher); }   // 교사는 시간 제한 없음
function isAdmin() { const s = MODE === 'server' && API.getSession(); return !!(s && s.teacher && s.admin); }   // 관리자 = 시트 소유자
function isNightLocked() { const c = CONFIG.nightLock; return c.enabled && !serverSettings.nightLockOff && !isTeacher() && !(state && state.settings.bypassLock) && inRange(nowHour(), c.start, c.end); }
function isClassLocked() { const c = serverSettings.classLock || CONFIG.classLock; return !!c.enabled && !isTeacher() && !(state && state.settings.bypassLock) && inRange(nowHour(), Number(c.start), Number(c.end)); }
function checkLocks() {
  $('#overlay-lock').classList.toggle('hidden', !isNightLocked());
  $('#lock-banner').classList.toggle('hidden', !isClassLocked());
}
async function syncServerTime() {
  const r = await API.getTime();
  if (r && r.serverTime) serverOffset = new Date(r.serverTime).getTime() - Date.now();
  checkLocks();
}

/* ---------------- 로그인 / 가입 ---------------- */
function renderLogin(mode = 'login', msg = '') {
  const ov = $('#overlay-login'); ov.classList.remove('hidden');
  const body = $('#login-body');
  if (MODE === 'local') {
    body.innerHTML = `<h2>🏠 스터디룸에 어서 오세요!</h2><p class="muted">오늘 배운 내용을 정리하면 코인과 가구를 받아 나만의 방을 꾸밀 수 있어요.</p>
      <div class="notice">로컬 모드예요. 기록은 이 브라우저에만 저장돼요. (서버 연동은 js/catalog.js 의 CONFIG.gasUrl)</div>
      <label>학번 <input id="f-id" type="text" inputmode="numeric" placeholder="예: 0000" maxlength="10" autocomplete="off" name="studyroom-sid"></label>
      <label>이름 <input id="f-name" type="text" placeholder="예: 홍길동" maxlength="10" autocomplete="off" name="studyroom-name"></label>
      <button id="f-go" class="btn primary big">입장하기</button>`;
    $('#f-go').onclick = () => {
      const id = $('#f-id').value.trim(), name = $('#f-name').value.trim();
      if (!id || !name) return toast('학번과 이름을 입력해 주세요', 'bad');
      state = Engine.migrate(Engine.newState({ id, name }, todayKey()), units); saveLocal();
      ov.classList.add('hidden'); start();
    };
    return;
  }
  if (mode === 'login') {
    body.innerHTML = `<h2>🏠 스터디룸</h2><p class="muted">학번과 비밀번호로 들어와요. 다른 기기에서도 같은 방을 볼 수 있어요.</p>
      ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
      <label>학번 <input id="f-id" type="text" inputmode="numeric" placeholder="예: 0000" maxlength="10" autocomplete="off" name="studyroom-sid"></label>
      <label>비밀번호 <input id="f-pw" type="password" placeholder="비밀번호" maxlength="30" autocomplete="new-password" name="studyroom-pw"></label>
      <button id="f-go" class="btn primary big">들어가기</button>
      <p class="small" style="margin-top:12px">처음이에요? <button class="link" id="f-reg">학번·비밀번호 만들기</button></p>
      <p class="muted small">비밀번호를 잊었으면 선생님께 초기화를 요청하세요.</p>
      <p class="small" style="margin-top:8px;text-align:right"><button class="link" id="f-teacher">👩‍🏫 교사로 접속</button></p>`;
    $('#f-reg').onclick = () => renderLogin('register');
    $('#f-teacher').onclick = () => renderLogin('teacher');
    $('#f-go').onclick = () => auth('login', { id: $('#f-id').value.trim(), password: $('#f-pw').value });
    $('#f-pw').onkeydown = e => { if (e.key === 'Enter') $('#f-go').click(); };
  } else if (mode === 'teacher') {
    body.innerHTML = `<h2>👩‍🏫 교사로 접속</h2>
      ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
      <p class="muted small">스터디룸 DB 시트의 메뉴 <b>🏠 스터디룸 → ⑧ 내 교사 접속 코드 보기</b>에서 받은 코드를 붙여 넣으세요. (구글 계정 + 관리자 승인으로 발급) 교사는 시간 제한 없이 사용하고 모든 학생 방을 볼 수 있어요.</p>
      <div id="f-tmail">
        <label>교사 이메일 <input id="f-email" type="email" placeholder="예: teacher@school.kr" maxlength="80" autocomplete="username" value="${esc(localStorage.getItem('studyroom_temail') || '')}"></label>
        <label>교사 비밀번호 <input id="f-tpw" type="password" maxlength="40" autocomplete="current-password"></label>
        <button id="f-go" class="btn primary big">교사로 들어가기</button>
        <p class="small" style="margin-top:10px"><button class="link" id="f-usecode">처음이거나 비밀번호를 잊었어요 → 접속 코드로 등록하기</button></p>
      </div>
      <div id="f-tcode" class="hidden">
        <p class="muted small">처음 한 번만 <b>접속 코드 + 이메일 + 비밀번호</b>를 넣어요. 다음부터는 이메일과 비밀번호만 넣으면 돼요. 코드는 스터디룸 DB 시트의 <b>🏠 스터디룸 → ⑧ 내 교사 접속 코드 보기</b>에서 받아요.</p>
        <label>교사 접속 코드 <input id="f-code" type="text" placeholder="예: AB12-CD34 (8자리)" maxlength="20" autocomplete="off"></label>
        <label>교사 이메일 (코드를 받은 구글 계정) <input id="f-email2" type="email" placeholder="예: teacher@school.kr" maxlength="80" autocomplete="username" value="${esc(localStorage.getItem('studyroom_temail') || '')}"></label>
        <label>앞으로 쓸 비밀번호 (6자 이상) <input id="f-pw-new" type="password" maxlength="40" autocomplete="new-password"></label>
        <div class="notice small">⚠️ 교사 비밀번호는 관리자가 확인할 수 있어요. 은행·포털 등 다른 곳에서 쓰는 중요한 비밀번호는 쓰지 말고, 이 앱 전용 비밀번호를 정해 주세요.</div>
        <button id="f-go2" class="btn primary big">등록하고 들어가기</button>
        <p class="small" style="margin-top:10px"><button class="link" id="f-usemail">← 이메일로 들어가기</button></p>
      </div>
      <p class="small" style="margin-top:12px"><button class="link" id="f-back">← 학생 로그인</button></p>`;
    $('#f-back').onclick = () => renderLogin('login');
    $('#f-usecode').onclick = () => { $('#f-tmail').classList.add('hidden'); $('#f-tcode').classList.remove('hidden'); };
    $('#f-usemail').onclick = () => { $('#f-tcode').classList.add('hidden'); $('#f-tmail').classList.remove('hidden'); };
    $('#f-go').onclick = () => { const email = $('#f-email').value.trim().toLowerCase(); try { localStorage.setItem('studyroom_temail', email); } catch (e) { /* ignore */ } auth('teacherLogin', { email, password: $('#f-tpw').value }); };
    $('#f-tpw').onkeydown = e => { if (e.key === 'Enter') $('#f-go').click(); };
    $('#f-go2').onclick = () => {
      const code = $('#f-code').value.trim(), email = $('#f-email2').value.trim().toLowerCase(), password = $('#f-pw-new').value;
      if (!code) return toast('교사 접속 코드를 입력해 주세요', 'bad');
      if (!email) return toast('교사 이메일을 입력해 주세요', 'bad');
      if (password.length < 6) return toast('비밀번호는 6자 이상이에요', 'bad');
      try { localStorage.setItem('studyroom_temail', email); } catch (e) { /* ignore */ }
      auth('teacherLogin', { code, email, password }, '#f-go2');
    };
  } else {
    body.innerHTML = `<h2>👋 처음 만들기</h2>
      <div class="notice">학번·이름·비밀번호와 학습 기록은 <b>선생님이 지정한 학교 폴더에만</b> 저장되고 외부로 전송되지 않아요. 비밀번호는 암호화되어 저장돼요.</div>
      <label>학번 <input id="f-id" type="text" inputmode="numeric" placeholder="예: 0000" maxlength="10" autocomplete="off" name="studyroom-sid"></label>
      <label>이름 <input id="f-name" type="text" placeholder="예: 홍길동" maxlength="10" autocomplete="off" name="studyroom-name"></label>
      <label>비밀번호 <input id="f-pw" type="password" placeholder="4자 이상" maxlength="30" autocomplete="new-password" name="studyroom-pw"></label>
      <label>비밀번호 확인 <input id="f-pw2" type="password" maxlength="30" autocomplete="new-password" name="studyroom-pw2"></label>
      <label>가입 코드 <input id="f-join" type="text" placeholder="선생님이 알려준 코드 (없으면 비워 두세요)" maxlength="40"></label>
      <button id="f-go" class="btn primary big">만들고 들어가기</button>
      <p class="small" style="margin-top:12px"><button class="link" id="f-back">← 이미 있어요</button></p>`;
    $('#f-back').onclick = () => renderLogin('login');
    $('#f-go').onclick = () => {
      const pw = $('#f-pw').value;
      if (pw.length < 4) return toast('비밀번호는 4자 이상이에요', 'bad');
      if (pw !== $('#f-pw2').value) return toast('비밀번호 확인이 달라요', 'bad');
      auth('register', { id: $('#f-id').value.trim(), name: $('#f-name').value.trim(), password: pw, joinCode: $('#f-join').value.trim() });
    };
  }
}
async function auth(action, payload, btnSel = '#f-go') {
  const mode = action === 'teacherLogin' ? 'teacher' : action;
  if (action === 'teacherLogin' && !payload.code && !(payload.email && payload.password)) return toast('이메일과 비밀번호를 입력해 주세요', 'bad');
  if (action !== 'teacherLogin' && !payload.id) return toast('학번을 입력해 주세요', 'bad');
  if (action === 'register' && !payload.name) return toast('이름을 입력해 주세요', 'bad');
  $(btnSel).disabled = true; $(btnSel).textContent = '확인 중...';
  try {
    const r = await API.call(Object.assign({ action }, payload));
    if (!r.ok) {
      if (r.error === 'night_lock') { $('#overlay-login').classList.add('hidden'); $('#overlay-lock').classList.remove('hidden'); return; }
      let msg = r.message || '로그인에 실패했어요';
      if (action === 'teacherLogin') {                      // 서버가 예전 버전이면 재배포 안내
        const t = await API.getTime();
        if (t && !(t.version >= 3)) msg = '서버(Apps Script)가 예전 버전이라 8자리 교사 코드를 아직 몰라요. Apps Script에서 Code.gs를 최신으로 바꾼 뒤 "배포 → 배포 관리 → 새 버전"을 해 주세요.';
      }
      return renderLogin(mode, msg);
    }
    API.setSession({ token: r.token, id: r.id || payload.id, name: r.name, teacher: !!r.teacher, admin: !!r.admin });
    setTopics(r.units); if (r.coupons) coupons = r.coupons; if (r.events) events = r.events; if (r.settings) { serverSettings = r.settings; applyPricing(r.settings.prices); applyItemPrices(r.settings.itemPrices); } if (r.items) applyItems(r.items); state = Engine.migrate(r.state, units); inbox = r.inbox || inbox;
    $('#overlay-login').classList.add('hidden');
    if (r.mustChange) changePasswordModal(true);
    start();
    toast(r.pwSet ? `${r.name}님, 등록했어요! 다음부터는 이메일과 비밀번호로 들어오세요` : `${r.name}님, 환영해요!`, 'ok');
  } catch (e) {
    renderLogin(mode, e.message === 'busy' ? '지금 접속이 많아요. 잠시 후 다시 시도해 주세요.' : '서버에 연결할 수 없어요. 인터넷을 확인해 주세요.');
  }
}
function changePasswordModal(forced) {
  modal(`<h2>🔑 새 비밀번호 설정</h2>${forced ? '<div class="notice">선생님이 비밀번호를 초기화했어요. 새 비밀번호를 정해 주세요.</div>' : ''}
    <label>새 비밀번호 <input id="pw1" type="password" maxlength="30"></label><label>확인 <input id="pw2" type="password" maxlength="30"></label>
    <div class="btn-row"><button class="btn primary" id="pw-go">저장</button>${forced ? '' : '<button class="btn ghost" id="pw-cancel">취소</button>'}</div>`);
  const c = $('#pw-cancel'); if (c) c.onclick = closeModal;
  $('#pw-go').onclick = async () => {
    const p = $('#pw1').value; if (p.length < 4) return toast('4자 이상이에요', 'bad'); if (p !== $('#pw2').value) return toast('확인이 달라요', 'bad');
    const r = await API.call({ action: 'changePassword', password: p }).catch(() => ({ ok: false }));
    if (r.ok) { closeModal(); toast('비밀번호를 바꿨어요', 'ok'); } else toast(r.message || '실패했어요', 'bad');
  };
}
function logout() {
  if (MODE === 'server') API.clearSession();
  clearInterval(pollTimer);
  state = null; location.reload();
}

/* ---------------- 내 방 (단원별) ---------------- */
function roomIds() { return [Engine.HOME]; }   // 방은 하나
let tUnit = null;                                 // 교사: 활동 현황에서 고른 단원
function currentRoom() { return Engine.room(state, currentRoomId); }
function renderRoom() {
  currentRoomId = Engine.HOME;
  const tabs = $('#room-tabs');
  if (isTeacher()) {   // 교사: 단원별 활동 현황 칩 (방 전환이 아니라 아래 접속 카드의 단원 선택)
    if (!tUnit || !unitOf(tUnit)) { const busy = units.find(u => onlineList.some(st => st.where === u.id)); tUnit = busy ? busy.id : (units[0] ? units[0].id : null); }
    tabs.classList.remove('hidden');
    tabs.innerHTML = units.map(u => { const here = onlineList.filter(st => st.where === u.id).length;
      return `<button class="room-tab ${u.id === tUnit ? 'on' : ''}" data-id="${esc(u.id)}">${esc(u.subject + ' · ' + u.title)} <b>👥 ${here}</b> <small>· 시작 ${unitStats.stats[u.id] || 0}명</small></button>`; }).join('');
    $$('.room-tab').forEach(b => b.onclick = () => { tUnit = b.dataset.id; renderRoom(); });
  } else { tabs.classList.add('hidden'); tabs.innerHTML = ''; }
  
  renderRoomPanel();
}
function layoutOf(room) { return room.inventory.map(i => ({ uid: i.uid, placed: !!i.placed, x: i.x, y: i.y, rot: i.rot || 0, side: i.side, pos: i.pos })); }
function sendLayout() { dispatch({ type: 'layout', unitId: currentRoomId, items: layoutOf(currentRoom()) }); }
function afterRoomChange() {
  const syn = myRoom.checkSynergies();
  syn.newly.forEach(id => { const s = SYNERGIES.find(x => x.id === id); toast(`✨ 히든 시너지 발동! ${s.name}`, 'ok'); });
  sendLayout();
  renderRoomPanel();
}
function renderRoomPanel() {
  if (isTeacher()) {   // 교사: 꾸미기 패널 대신 학생 활동 현황
    ['#selected-tools', '#monster-card', '#synergy-list', '#inbox-card', '#inv-card', '#deco-card', '#privacy-card'].forEach(sel => { const el = $(sel); if (el) el.classList.add('hidden'); });
    renderRoomHint();
    pollUnitStats(false);
    renderOnlineCard();
    return;
  }
  const room = currentRoom();
  const inv = room.inventory.filter(i => !i.placed);
  $('#inv-count').textContent = `${inv.length}개`;
  $('#inventory-list').innerHTML = inv.length
    ? inv.map(i => `<div class="inv-item" data-uid="${i.uid}" title="방에 놓기"><span class="emoji">${ITEMS[i.id].emoji}</span>${esc(ITEMS[i.id].name)}${i.unitId && unitOf(i.unitId) ? `<small class="muted"> · ${esc(unitTitle(i.unitId))}</small>` : ''}<span class="rar" style="color:${RARITY[ITEMS[i.id].rarity].color}">${RARITY[ITEMS[i.id].rarity].name}</span></div>`).join('')
    : '<div class="inv-empty">보관함이 비어 있어요. 요약을 통과하면 가구 상자를 받고, 상점에서 살 수도 있어요!</div>';
  $$('#inventory-list .inv-item').forEach(el => el.onclick = () => {
    if (isClassLocked()) return toast('수업 시간에는 인테리어가 잠겨 있어요', 'bad');
    const it = room.inventory.find(i => i.uid === +el.dataset.uid);
    if (myRoom.place(it)) { afterRoomChange(); toast(`${ITEMS[it.id].name}을(를) 방에 놓았어요. 끌어서 옮겨 보세요!`); }
    else toast('빈 자리가 없어요. 다른 가구를 보관함에 넣어 보세요.', 'bad');
  });

  const sel = room.inventory.find(i => i.uid === myRoom.getSelected());
  const tools = $('#selected-tools');
  tools.classList.toggle('hidden', !sel);
  if (sel) {
    const def = ITEMS[sel.id];
    tools.innerHTML = `
      <h3>${def.emoji} ${esc(def.name)} <small>${RARITY[def.rarity].name}</small></h3>
      <div class="btn-row">${def.wall ? '' : '<button class="btn" id="btn-rotate">🔄 회전</button>'}<button class="btn" id="btn-unplace">📦 보관함으로</button>${sel.img ? '<button class="btn accent" id="btn-view-img">🔍 크게 보기</button>' : ''}</div>
      <div class="row-label">색상 리폼 <small>(🪙 ${CONFIG.recolorCost})</small></div>
      <div class="swatches" id="color-swatches">${Object.entries(PALETTE).map(([k, p]) => `<div class="swatch ${sel.color === k ? 'on' : ''}" data-color="${k}" title="${p.name}" style="background:${p.hex}"></div>`).join('')}</div>
      <div class="row-label">스타일 <small>(🪙 ${CONFIG.restyleCost})</small></div>
      <div class="chips" id="style-chips">${Object.entries(STYLES).map(([k, s]) => `<span class="chip ${sel.style === k ? 'on' : ''}" data-style="${k}">${s.name}</span>`).join('')}</div>
      ${sel.id === 'photo_frame' ? `<div class="row-label" style="margin-top:10px">사진</div>
        <p class="muted small">${sel.img ? (sel.approved ? '✅ 선생님 승인 완료 — 컬러로 전시 중' : '⏳ 선생님 승인 대기 중 — 흑백으로 표시돼요') : '아직 사진이 없어요. (월 1회)'}</p>
        ${sel.img ? '' : '<button class="btn accent" id="btn-photo">📷 사진 올리기</button>'}` : ''}`;
    const rot = $('#btn-rotate'); if (rot) rot.onclick = () => { if (myRoom.rotate(sel)) afterRoomChange(); else toast('그 방향으로는 공간이 부족해요', 'bad'); };
    const vi = $('#btn-view-img'); if (vi) vi.onclick = () => showImageModal(sel.img, def.name, sel.id === 'photo_frame' && !sel.approved);
    $('#btn-unplace').onclick = () => { myRoom.unplace(sel); afterRoomChange(); };
    $$('#color-swatches .swatch').forEach(s => s.onclick = async () => {
      const r = await dispatch({ type: 'restyle', unitId: currentRoomId, uid: sel.uid, color: s.dataset.color });
      if (r.ok) { renderRoomPanel(); toast(`${PALETTE[s.dataset.color].name} 색으로 리폼했어요!`, 'ok'); }
    });
    $$('#style-chips .chip').forEach(c => c.onclick = async () => {
      const r = await dispatch({ type: 'restyle', unitId: currentRoomId, uid: sel.uid, style: c.dataset.style });
      if (r.ok) { renderRoomPanel(); toast(`${STYLES[c.dataset.style].name} 스타일로 바꿨어요!`, 'ok'); }
    });
    const ph = $('#btn-photo'); if (ph) ph.onclick = () => photoConsentModal(sel);
  }

  const mc = $('#monster-card');
  mc.classList.toggle('hidden', !room.monster);
  if (room.monster) {
    const u = unitOf(room.monster.unitId); const t = topicOf(room.monster.topicId);
    mc.innerHTML = `<h3>👾 오개념 먼지 괴물이 나타났어요!</h3><p class="small"><b>${esc(u ? u.title : unitTitle(room.monster.unitId))}${t ? ' · ' + esc(t.code || '') : ''}</b> 요약에 재도전해서 통과하면 괴물이 정화되고 보너스 코인(🪙 ${CONFIG.rewards.monsterBonus})을 받아요.</p>
      ${u && t ? '<button class="btn primary" id="btn-retry-monster">다시 도전하기</button>' : ''}`;
    const b = $('#btn-retry-monster'); if (b) b.onclick = () => { study = { step: 'quiz', unit: u, topic: t, answers: {}, graded: false }; showScreen('study'); };
  }

  const syn = myRoom.checkSynergies();
  const sl = $('#synergy-list');
  sl.classList.toggle('hidden', !syn.active.length);
  sl.innerHTML = `<h3>✨ 히든 시너지</h3>` + syn.active.map(id => { const s = SYNERGIES.find(x => x.id === id); return `<div class="synergy">🔥 <b>${s.name}</b> — ${s.desc}</div>`; }).join('');

  $$('.wallpaper-cost').forEach(e => e.textContent = CONFIG.wallpaperCost);
  const mk = (key, list) => list.map(([n, hex]) => `<div class="swatch ${room[key] === hex ? 'on' : ''}" data-hex="${hex}" title="${n}" style="background:${hex}"></div>`).join('');
  $('#wall-colors').innerHTML = mk('wall', ROOM_COLORS.wall);
  $('#floor-colors').innerHTML = mk('floor', ROOM_COLORS.floor);
  [['#wall-colors', 'wall'], ['#floor-colors', 'floor']].forEach(([s, key]) => $$(s + ' .swatch').forEach(el => el.onclick = async () => {
    if (room[key] === el.dataset.hex) return;
    const r = await dispatch({ type: 'wallpaper', unitId: currentRoomId, key, hex: el.dataset.hex });
    if (r.ok) { renderRoomPanel(); toast('방 분위기가 바뀌었어요!', 'ok'); }
  }));
  $('#privacy-select').value = state.settings.privacy;
  renderInbox();
  renderOnlineCard();
}
function photoConsentModal(frame) {
  modal(`<h2>📷 사진 올리기 전에 확인해요</h2>
    <div class="notice">사진은 <b>내 방 액자에만</b> 보이고, 선생님 승인 전에는 흑백으로 나와요. 사진 파일은 따로 저장하지 않고 학교 폴더 안의 내 기록에만 들어가요.</div>
    <div class="consent">
      <label><input type="checkbox" class="ck"> <span><b>개인정보</b>: 이름·주소·학교·전화번호 등 개인정보가 보이는 사진이 아니에요.</span></label>
      <label><input type="checkbox" class="ck"> <span><b>초상권</b>: 나와 다른 사람의 얼굴이 나오지 않아요. (반려동물·풍경·물건 사진은 괜찮아요)</span></label>
      <label><input type="checkbox" class="ck"> <span><b>저작권</b>: 내가 직접 찍었거나 사용해도 된다고 허락받은 사진이에요. (연예인·게임·만화 캡처는 안 돼요)</span></label>
      <label><input type="checkbox" class="ck"> <span>친구들에게 보여도 괜찮은, 학교에서 쓰기에 적절한 사진이에요.</span></label>
    </div>
    <p class="small" id="photo-guide" style="margin:10px 0 6px;color:#b45309"><b>위 4가지에 모두 체크하면</b> 사진을 고를 수 있어요. (0/4)</p>
    <input type="file" id="photo-file" accept="image/*">
    <div class="btn-row"><button class="btn ghost" id="photo-cancel">취소</button></div>`);
  const file = $('#photo-file');
  const allChecked = () => $$('#modal-body .ck').every(x => x.checked);
  const updateGuide = () => { const n = $$('#modal-body .ck').filter(x => x.checked).length; const g = $('#photo-guide'); if (!g) return; g.innerHTML = n === 4 ? '✅ 확인 완료! 아래에서 사진 파일을 고르세요.' : `<b>위 4가지에 모두 체크하면</b> 사진을 고를 수 있어요. (${n}/4)`; g.style.color = n === 4 ? '#166534' : '#b45309'; };
  $$('#modal-body .ck').forEach(c => c.onchange = updateGuide);
  $('#photo-cancel').onclick = closeModal;
  file.onclick = e => { if (!allChecked()) { e.preventDefault(); toast('먼저 위 4가지 확인 항목에 모두 체크해 주세요', 'bad'); } };
  file.onchange = () => {
    const f = file.files[0]; if (!f) return;
    if (!allChecked()) { file.value = ''; return toast('먼저 위 4가지 확인 항목에 모두 체크해 주세요', 'bad'); }
    if (!/^image\//.test(f.type)) { file.value = ''; return toast('이미지 파일(jpg, png 등)만 올릴 수 있어요', 'bad'); }
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = async () => {
        const cv = document.createElement('canvas'); cv.width = 240; cv.height = 160;
        const c = cv.getContext('2d'); const r = Math.max(240 / im.width, 160 / im.height);
        c.drawImage(im, (240 - im.width * r) / 2, (160 - im.height * r) / 2, im.width * r, im.height * r);
        let q = 0.8, img = cv.toDataURL('image/jpeg', q);
        while (img.length > CONFIG.photoMaxChars && q > 0.3) { q -= 0.1; img = cv.toDataURL('image/jpeg', q); }
        closeModal();
        const res = await dispatch({ type: 'photo', unitId: currentRoomId, uid: frame.uid, img, consent: true }, true);
        if (res.ok) { renderRoomPanel(); toast('사진을 올렸어요! 선생님이 승인하면 컬러로 바뀌어요.', 'ok'); }
      };
      im.src = rd.result;
    };
    rd.readAsDataURL(f);
  };
}
function renderInbox() {
  const card = $('#inbox-card');
  if (MODE !== 'server') { card.classList.add('hidden'); return; }
  const knocks = inbox.knocks || [], st = (inbox.stickers || []).slice(0, 3);
  card.classList.toggle('hidden', !knocks.length && !st.length);
  card.innerHTML = `<h3>📬 우편함</h3>` +
    knocks.map(k => `<div class="friend-row"><span class="name">🚪 ${esc(k.name)}이(가) 노크했어요</span><button class="btn primary tiny allow" data-id="${esc(k.from)}">문 열어주기</button><button class="btn tiny deny" data-id="${esc(k.from)}">무시</button></div>`).join('') +
    st.map(s => `<div class="small">✨ ${esc(s.name)}이(가) 내 요약에 영감 스티커를 남겼어요 (${shortDate(s.date)})</div>`).join('');
  $$('#inbox-card .allow').forEach(b => b.onclick = () => answerKnock(b.dataset.id, true));
  $$('#inbox-card .deny').forEach(b => b.onclick = () => answerKnock(b.dataset.id, false));
}
async function answerKnock(visitorId, allow) {
  const r = await API.call({ action: 'allow', visitorId, allow }).catch(() => ({ ok: false }));
  if (r.ok) { inbox.knocks = inbox.knocks.filter(k => k.from !== visitorId); renderInbox(); toast(allow ? `문을 열어줬어요. ${CONFIG.visitMinutes}분 동안 들어올 수 있어요` : '조용히 넘겼어요'); }
  else toast(r.message || '실패했어요', 'bad');
}
async function pollInbox() {
  if (MODE !== 'server' || !state) return;
  if (isTeacher()) return pollOnline();
  try { const r = await API.call({ action: 'inbox' }); if (r.ok) { inbox = r.inbox; if (r.settings) { serverSettings = r.settings; applyPricing(r.settings.prices); checkLocks(); } if ($('#screen-room').classList.contains('active')) renderInbox(); } } catch (e) { /* ignore */ }
}

/* ---------------- 학습하기 ---------------- */
function getRecord(unitId) { return state.records.find(r => r.unitId === unitId && r.date === todayKey()); }
function steps(cur) {
  const s = [['quiz', '① 형성평가'], ['summary', '② 한 줄 요약'], ['result', '③ AI 판정 & 보상']];
  return `<div class="steps">${s.map(([k, n]) => `<span class="${k === cur ? 'on' : ''}">${n}</span>`).join('<span>›</span>')}</div>`;
}
function renderStudy() {
  const body = $('#study-body');
  const todayRecs = state.records.filter(r => r.date === todayKey());
  const recOf = tid => todayRecs.find(r => r.topicId === tid);
  if (study.step === 'units') {
    body.innerHTML = `<div class="card"><h2>📝 오늘 배운 내용 정리하기</h2><p class="muted">단원을 고르고 <b>성취기준</b>을 하나 골라요. 그 성취기준의 형성평가를 풀고 배운 내용을 요약하면, <b>요약에서 열린 개념 수만큼 코인</b>을 받고 통과하면 가구 상자도 받아요. (성취기준마다 하루 1회)</p></div>
      ${units.length ? `<div class="unit-grid">${units.map(u => {
        const done = u.topics.filter(t => { const r = recOf(t.id); return r && r.pass; }).length;
        const tried = u.topics.filter(t => recOf(t.id)).length;
        const st = done === u.topics.length ? `<span class="state pass">✅ 오늘 ${done}/${u.topics.length} 모두 통과</span>` : tried ? `<span class="state">🔓 오늘 ${done}/${u.topics.length} 통과 · ${tried}개 도전</span>` : `<span class="state muted">성취기준 ${u.topics.length}개</span>`;
        return `<div class="card unit-card" data-unit="${esc(u.id)}"><div class="subject">${esc(u.subject)}</div><div class="title">${esc(u.title)}</div>${st}</div>`;
      }).join('')}</div>` : '<div class="card muted">아직 등록된 단원이 없어요. 선생님이 단원 시트에 입력하면 나타나요.</div>'}`;
    $$('.unit-card').forEach(el => el.onclick = () => { study = { step: 'topics', unit: unitOf(el.dataset.unit) }; renderStudy(); });
    return;
  }
  const u = study.unit;
  if (study.step === 'topics') {
    body.innerHTML = `<div class="card"><div class="subject muted small">${esc(u.subject)}</div><h2>${esc(u.title)}</h2><p class="muted small">성취기준을 하나 골라요. 형성평가와 요약은 그 성취기준의 내용만 다뤄요.</p>
      ${u.topics.map(t => {
        const r = recOf(t.id); const total = t.conceptCount || (t.keyConcepts ? t.keyConcepts.length : 0);
        const st = !r ? '<span class="state muted">아직 안 했어요</span>' : r.pass ? `<span class="state pass">✅ 통과 · 개념 ${r.opened.length}/${total} 열림 · 🪙 ${r.reward ? r.reward.coins : 0}</span>` : `<span class="state retry">🔓 개념 ${r.opened.length}/${total} 열림 · 🪙 ${r.reward ? r.reward.coins : 0} · 재도전 가능</span>`;
        return `<div class="card unit-card topic-card" data-topic="${esc(t.id)}"><div class="subject">${esc(t.code || '')}</div><div class="small" style="margin:4px 0 6px">${esc(t.standard.split('\n')[0].replace(/^\[[^\]]+\]\s*/, ''))}</div>${st}</div>`;
      }).join('')}
      <div class="btn-row"><button class="btn ghost" id="btn-back">← 단원 선택</button></div></div>`;
    $('#btn-back').onclick = () => { study = { step: 'units' }; renderStudy(); };
    $$('.topic-card').forEach(el => el.onclick = () => { study = { step: 'quiz', unit: u, topic: topicOf(el.dataset.topic), answers: {}, graded: false }; renderStudy(); });
    return;
  }
  const t = study.topic;
  if (study.step === 'quiz') {
    body.innerHTML = `<div class="card">${steps('quiz')}<div class="subject muted small">${esc(u.subject)} · ${esc(u.title)}</div><h2>${esc(t.code || '')} 형성평가</h2>
      <div class="standard">🎯 ${esc(t.standard.split('\n')[0])}</div>
      ${t.questions.map((q, i) => `<div class="q" data-i="${i}" style="margin-top:12px"><div class="qt">Q${i + 1}. ${esc(q.q)}</div>${q.img ? `<div class="qimg" data-fid="${esc(q.img)}"><img alt="문제 그림" style="max-width:100%;max-height:360px;border-radius:10px;margin:6px 0;display:none"><span class="muted small">그림 불러오는 중...</span></div>` : ''}
        ${q.type === 'mc' ? `<div class="choices">${q.choices.map((c, j) => `<label class="choice"><input type="radio" name="q${i}" value="${j}" ${study.graded ? 'disabled' : ''} ${study.answers[i] == j ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}</div>`
          : `<input type="text" class="short" data-i="${i}" placeholder="답을 입력하세요" value="${esc(study.answers[i] || '')}" ${study.graded ? 'disabled' : ''}>`}
        <div class="feedback" id="fb${i}"></div></div>`).join('')}
      <div class="btn-row">
        ${study.graded ? '<button class="btn primary big" id="btn-next">요약 쓰러 가기 →</button>' : '<button class="btn primary big" id="btn-grade">채점하기</button>'}
        <button class="btn ghost" id="btn-back">← 성취기준 선택</button>
        </div></div>${isTeacher() ? '<div class="card" id="t-questions" style="background:#eef6ff"></div>' : ''}`;
    $('#btn-back').onclick = () => { study = { step: 'topics', unit: u }; renderStudy(); };
    loadQuestionImages($('#study-body'));
    if (isTeacher()) { tAdmin.unitId = u.id; tAdmin.topicId = t.id; renderTQuestions(true); }   // 교사: 형성평가 아래에 이 성취기준의 문항 편집기
    if (study.graded) { showQuizFeedback(); $('#btn-next').onclick = () => { study.step = 'summary'; renderStudy(); }; }
    else $('#btn-grade').onclick = async () => {
      t.questions.forEach((q, i) => {
        if (q.type === 'mc') { const c = document.querySelector(`input[name=q${i}]:checked`); study.answers[i] = c ? +c.value : null; }
        else study.answers[i] = $(`.short[data-i="${i}"]`).value.trim();
      });
      if (t.questions.some((q, i) => study.answers[i] === null || study.answers[i] === '')) return toast('모든 문항에 답해 주세요', 'bad');
      $('#btn-grade').disabled = true;
      if (MODE === 'local') study.grade = Engine.grade(t, study.answers);
      else {
        try { const r = await API.call({ action: 'grade', topicId: t.id, answers: study.answers }); if (!r.ok) return handleServerError(r), $('#btn-grade').disabled = false; study.grade = r.result; }
        catch (e) { $('#btn-grade').disabled = false; return toast('인터넷 연결을 확인해 주세요', 'bad'); }
      }
      study.graded = true; renderStudy();
    };
    return;
  }
  if (study.step === 'summary') {
    const total = t.conceptCount || (t.keyConcepts ? t.keyConcepts.length : 0);
    body.innerHTML = `<div class="card">${steps('summary')}<div class="subject muted small">${esc(u.subject)} · ${esc(u.title)}</div><h2>${esc(t.code || '')} 배운 내용 요약</h2>
      <div class="standard">🎯 ${esc(t.standard.split('\n')[0])}</div>
      <p class="small muted" style="margin:10px 0 6px">이 성취기준의 핵심 개념 <b>${total}개</b>가 숨어 있어요. 개념을 하나 쓸 때마다 열리고 🪙 ${CONFIG.rewards.conceptCoin}씩 받아요. 개념들이 <b>왜, 어떻게</b> 연결되는지 자기 말로 써야 통과해요.</p>
      <textarea id="summary-text" placeholder="예) ~하기 때문에 ~가 되고, 그래서 ~한다.">${esc(study.text || '')}</textarea>
      <div class="counter"><span id="char-count">0</span>자 / 최소 ${CONFIG.minLength}자</div>
      ${study.result && !study.result.pass ? `<div class="hintbox">💡 <b>발판 힌트</b> — ${esc(study.result.hint)}</div>` : ''}
      <div class="btn-row"><button class="btn primary big" id="btn-submit">AI 조교에게 제출하기</button><button class="btn ghost" id="btn-back">← 형성평가</button></div></div>`;
    const ta = $('#summary-text'); const cnt = () => $('#char-count').textContent = ta.value.trim().length; ta.oninput = cnt; cnt();
    $('#btn-back').onclick = () => { study.step = 'quiz'; renderStudy(); };
    $('#btn-submit').onclick = submitSummary;
    return;
  }
  if (study.step === 'result') renderResult();
}
function showQuizFeedback() {
  study.topic.questions.forEach((q, i) => {
    const g = study.grade[i], fb = $(`#fb${i}`);
    if (q.type === 'mc') $$(`.q[data-i="${i}"] .choice`).forEach((el, j) => { if (j === study.answers[i]) el.classList.add(g.ok ? 'correct' : 'wrong'); });
    fb.className = 'feedback ' + (g.ok ? 'ok' : 'bad');
    fb.textContent = g.ok ? '정답이에요! 🎉' : `아쉬워요. 💡 힌트: ${g.hint}`;
  });
  toast(`형성평가 ${study.grade.filter(g => g.ok).length}/${study.grade.length} 정답! 요약을 쓰면 코인을 받아요.`);
}
let submitting = false;
async function submitSummary() {
  if (submitting) return;                        // 연타 방지
  const text = $('#summary-text').value.trim(); study.text = text;
  if (!text) return toast('요약을 입력해 주세요', 'bad');
  submitting = true; $('#btn-submit').disabled = true;
  showLoading(true);
  const started = Date.now();
  const r = await dispatch({ type: 'submit', topicId: study.topic.id, answers: study.answers, text }, true);
  await new Promise(res => setTimeout(res, Math.max(0, 2600 - (Date.now() - started))));
  showLoading(false); submitting = false;
  if (!r.ok) { renderStudy(); return; }
  if (MODE === 'local') saveLocal();
  const { res, outcome } = r.result;
  currentRoomId = Engine.HOME;
  if (outcome.purified && outcome.monsterAt) myRoom.purifyEffect(outcome.monsterAt.x, outcome.monsterAt.y, `+${CONFIG.rewards.monsterBonus} 코인`);
  study.result = res; study.outcome = outcome; study.step = 'result';
  renderStudy();
}
function renderResult() {
  const u = study.unit, t = study.topic, res = study.result, o = study.outcome;
  const rec = state.records.find(r => r.topicId === t.id && r.date === todayKey());
  const opened = rec ? rec.opened : res.hits;
  const chips = opened.map(h => `<span class="chip hit">${o.newlyOpened.includes(h) ? '✨ ' : '✔ '}${esc(h)}</span>`).join('') + '<span class="chip miss">?</span>'.repeat(Math.max(0, o.total - opened.length));
  const bd = o.breakdown || {};
  const bdText = [bd.concept ? `개념 ${o.newlyOpened.length}개 열림 +${bd.concept}` : '', bd.quiz ? `퀴즈 +${bd.quiz}` : '', bd.pass ? `통과 +${bd.pass}` : '', bd.first ? `첫 시도 +${bd.first}` : '', bd.monster ? `괴물 정화 +${bd.monster}` : ''].filter(Boolean).join(' · ');
  $('#study-body').innerHTML = `<div class="card">${steps('result')}<div class="subject muted small">${esc(u.title)} · ${esc(t.code || '')}</div>
    <div class="result-hero"><div class="big-emoji">${res.pass ? '🎉' : (o.newlyOpened.length ? '🔓' : '👾')}</div><h2>${res.pass ? '통과!' : (o.newlyOpened.length ? '개념이 열렸어요!' : '다시 도전!')}</h2><div class="score">${res.score}점</div>
      <div class="progress"><div style="width:${res.score}%"></div></div><p>${esc(res.feedback)}</p></div>
    <div class="row-label">열린 개념 (${opened.length}/${o.total}) <small class="muted">— ✨ 이번에 새로 열림 · ? 아직 숨어 있음</small></div>
    <div class="chips hit-chips">${chips}</div>
    ${o.coins ? `<div class="hintbox" style="background:#ecfdf5;border-color:#16a34a">🪙 <b>+${o.coins} 코인</b> <span class="small muted">(${esc(bdText)})</span>${res.pass && o.itemId ? ' 과 <b>가구 상자 📦</b>!' : ''}</div>` : (o.practice ? '<p class="muted">오늘 이 성취기준 보상은 이미 다 받았어요. 연습 기록으로 저장했어요 ✍️</p>' : '')}
    ${res.hint ? `<div class="hintbox">💡 <b>${res.pass ? '한 걸음 더' : '발판 힌트'}</b> — ${esc(res.hint)}</div>` : ''}
    ${!res.pass ? `<p class="muted">정답은 알려주지 않아요. 힌트를 보고 요약을 고쳐 다시 제출하면 <b>새로 열리는 개념마다 코인</b>을 더 받고, 통과하면 가구 상자를 받아요.${o.monster ? ' 이 단원 방에 오개념 먼지 괴물이 나타났어요 — 통과하면 정화 보너스!' : ''}</p>` : ''}
    <div class="btn-row">
      ${res.pass && o.itemId ? '<button class="btn primary big" id="btn-open-box">📦 가구 상자 열기</button>' : ''}
      ${!res.pass ? '<button class="btn primary big" id="btn-retry">✏️ 요약 고쳐서 재도전</button>' : ''}
      <button class="btn" id="btn-topics">다른 성취기준 하기</button><button class="btn ghost" id="btn-room">🛋️ 내 방으로</button></div></div>`;
  const ob = $('#btn-open-box'); if (ob) ob.onclick = () => openBox(o);
  const rt = $('#btn-retry'); if (rt) rt.onclick = () => { study.step = 'summary'; renderStudy(); };
  $('#btn-topics').onclick = () => { study = { step: 'topics', unit: u }; renderStudy(); };
  $('#btn-room').onclick = () => showScreen('room');
}
let streamTimer;
function showLoading(on) {
  $('#overlay-loading').classList.toggle('hidden', !on);
  const st = $('#loading-stream'); st.innerHTML = ''; clearInterval(streamTimer);
  if (!on) return;
  const pool = [...(typeof SAMPLE_SUMMARIES !== 'undefined' ? SAMPLE_SUMMARIES : []), ...state.records.filter(r => r.pass && r.score >= 80).map(r => r.summary)];
  const texts = ['AI 조교가 교과서를 확인 중...', '성취기준과 비교하는 중...', '오개념이 있는지 살펴보는 중...', '핵심 개념 연결을 확인하는 중...'];
  let k = 0;
  const push = () => {
    if (pool.length) { const d = document.createElement('div'); d.className = 'line'; d.textContent = '“' + pool[Math.floor(Math.random() * pool.length)] + '”'; d.style.top = (10 + Math.random() * 75) + '%'; d.style.fontSize = (0.9 + Math.random() * 0.6) + 'rem'; st.appendChild(d); setTimeout(() => d.remove(), 7200); }
    $('#loading-text').textContent = texts[(k++) % texts.length];
  };
  push(); streamTimer = setInterval(push, 900);
}
function openBox(o) {
  const ov = $('#overlay-box'), stage = $('#box-stage');
  ov.classList.remove('hidden');
  stage.innerHTML = `<div class="box-emoji" id="box-icon">📦</div><h2>가구 상자</h2><p class="muted">상자를 눌러 열어 보세요!</p>`;
  $('#box-icon').onclick = () => {
    const def = ITEMS[o.itemId], r = RARITY[def.rarity];
    stage.innerHTML = `<div class="reveal"><div class="emoji">${def.emoji}</div><div class="rarity" style="color:${r.color}">${r.name}${def.pool === 'event' ? ' · 이벤트 한정' : ''}</div><h2>${esc(def.name)}</h2>
      <p class="muted small">${esc(unitTitle(study.unit.id))} 방에 들어갔어요</p>
      <div class="btn-row" style="justify-content:center"><button class="btn primary" id="box-place">🛋️ 방에 놓기</button><button class="btn" id="box-keep">📦 보관함에 넣기</button></div></div>`;
    $('#box-place').onclick = () => {
      ov.classList.add('hidden'); currentRoomId = Engine.HOME;
      const it = currentRoom().inventory.find(i => i.uid === o.itemUid);
      if (isClassLocked() || !it) { showScreen('room'); return toast('보관함에 넣었어요'); }
      if (myRoom.place(it)) { showScreen('room'); afterRoomChange(); toast('방에 놓았어요! 끌어서 옮겨 보세요.', 'ok'); }
      else { showScreen('room'); toast('빈 자리가 없어 보관함에 넣었어요'); }
    };
    $('#box-keep').onclick = () => { ov.classList.add('hidden'); study = { step: 'units' }; renderStudy(); };
    study.outcome.itemId = null;
  };
}

/* ---------------- 서재 ---------------- */
function renderLibrary() {
  if (isTeacher()) return renderTeacherLibrary();
  const recs = state.records.slice().sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
  const progress = units.map(u => Object.assign({ unit: u }, Engine.unitProgress(state, topics, u.id)));
  const ready = progress.filter(p => p.total && p.passed >= p.total && !state.conceptMaps[p.unit.id]);
  const started = progress.filter(p => p.passed > 0);
  const stickerCount = {}; (inbox.stickers || []).forEach(s => stickerCount[s.key] = (stickerCount[s.key] || 0) + 1);
  $('#library-body').innerHTML = `
    <div class="card"><h2>📚 나의 서재</h2>
      <p class="muted small">내가 쓴 요약이 쌓이는 곳이에요. 통과한 요약만 <b>학습자료</b>로 친구에게 보여요. 점수·시도 횟수는 나와 선생님만 볼 수 있어요.</p>
      <div class="row-label">🧠 AI 개념도 액자 <small class="muted">— 한 단원의 성취기준을 모두 통과하면 그 단원의 개념도 액자와 🏆 단원 완성 트로피를 받아요</small></div>
      ${started.length ? started.map(p => `<div style="margin:6px 0"><div class="small"><b>${esc(p.unit.title)}</b> · 통과 ${p.passed}/${p.total} ${state.conceptMaps[p.unit.id] ? '<span class="tag pass">액자 받음 ✅</span> <button class="link btn-view-concept" data-unit="' + esc(p.unit.id) + '">🔍 개념도 보기</button>' : (p.passed >= p.total ? '<span class="tag best">완성!</span>' : '')}</div><div class="progress"><div style="width:${Math.round(p.passed / p.total * 100)}%"></div></div></div>`).join('') : '<p class="muted small">아직 통과한 성취기준이 없어요. 학습하기에서 시작해 보세요.</p>'}
      ${ready.length ? `<div class="btn-row">${ready.map(p => `<button class="btn primary btn-concept" data-unit="${esc(p.unit.id)}">🧠 ${esc(p.unit.title)} 개념도 액자 만들기</button>`).join('')}</div>` : ''}
    </div>
    <div class="card">${recs.length ? recs.map(r => {
      const u = unitOf(r.unitId); const key = r.date + '|' + (r.topicId || r.unitId);
      return `<div class="rec"><div class="meta"><b>${shortDate(r.date)}</b><span>${esc(u ? u.subject + ' · ' + u.title : unitTitle(r.unitId))}${topicCode(r.topicId) ? ' · ' + esc(topicCode(r.topicId)) : ''}</span>
        <span class="tag ${r.pass ? 'pass' : 'fail'}">${r.pass ? '통과 · 학습자료' : '재도전'}</span><span>${r.score}점</span><span>개념 ${(r.opened || []).length}개</span><span>퀴즈 ${r.quiz ? r.quiz.correct + '/' + r.quiz.total : '-'}</span>
        ${r.pass && r.score >= 80 ? '<span class="tag best">⭐ 우수 요약</span>' : ''}${stickerCount[key] ? `<span class="tag best">✨ 영감 스티커 ${stickerCount[key]}</span>` : ''}</div><div class="text">${esc(r.summary)}</div></div>`;
    }).join('') : '<p class="muted">아직 요약이 없어요. 학습하기에서 첫 요약을 써 보세요!</p>'}</div>
    ${MODE === 'server' ? `<div class="card" id="past-card"><h3>📜 지난 학번 자료 <small class="muted">— 학년이 바뀌어 새 학번으로 가입했다면</small></h3>
      <p class="muted small">지난 학번과 그때 쓰던 비밀번호를 넣으면 예전 방과 학습자료를 다시 볼 수 있어요. 보기만 할 수 있고 가구·코인은 옮겨지지 않아요.</p>
      ${(state.pastLinks || []).length ? `<div class="chips">${state.pastLinks.map(p => `<button class="chip past-link" data-id="${esc(p.id)}">📜 ${p.year ? p.year + '학년도 · ' : ''}${esc(p.id)} ${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px"><label style="margin:0;flex:1;min-width:120px">지난 학번 <input type="text" id="past-id" inputmode="numeric" maxlength="10" placeholder="예: 10301"></label><label style="margin:0;flex:1;min-width:120px">그때 비밀번호 <input type="password" id="past-pw" maxlength="30"></label><button class="btn primary" id="past-link">연결</button></div>
      <div id="past-view"></div></div>` : ''}`;
  const pl = $('#past-link'); if (pl) pl.onclick = async () => {
    const id = $('#past-id').value.trim(), password = $('#past-pw').value;
    if (!id || !password) return toast('지난 학번과 그때 비밀번호를 입력해 주세요', 'bad');
    const r = await API.call({ action: 'linkPast', id, password }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) { state.pastLinks = r.pastLinks || []; toast('지난 학번을 연결했어요', 'ok'); renderLibrary(); showPast(id); } else toast(r.message || '실패했어요', 'bad');
  };
  $$('.past-link').forEach(b => b.onclick = () => showPast(b.dataset.id));
  $$('.btn-concept').forEach(b => b.onclick = () => makeConceptFrame(b.dataset.unit));
  $$('.btn-view-concept').forEach(b => b.onclick = () => { const it = Engine.room(state).inventory.find(i => i.id === 'concept_frame' && i.img && i.unitId === b.dataset.unit); if (it) showImageModal(it.img, unitTitle(b.dataset.unit) + ' 개념도'); else toast('개념도 액자를 찾을 수 없어요', 'bad'); });
}
let pastRoom = null;
async function showPast(id) {
  const box = $('#past-view'); if (!box) return; box.innerHTML = '<p class="muted small">불러오는 중...</p>';
  const r = await API.call({ action: 'pastView', id }).catch(() => ({ ok: false, message: '연결 실패' }));
  if (!r.ok) { box.innerHTML = `<p class="muted">${esc(r.message || '불러오지 못했어요')}</p>`; return; }
  const v = r.view, rid = Object.keys(v.rooms)[0], recs = (v.records || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  box.innerHTML = `<h3 style="margin-top:14px">🏠 ${r.link.year ? r.link.year + '학년도 ' : ''}${esc(r.link.id)} ${esc(r.link.name)}의 방 <small class="muted">🪙 ${v.coins || 0} · 보기만 할 수 있어요</small></h3>
    ${rid ? '<canvas id="past-canvas" width="820" height="640"></canvas><div class="room-hint" id="past-hint"><span class="small muted">벽을 클릭하면 액자를 크게 볼 수 있어요.</span></div>' : '<p class="muted small">꾸민 방이 없어요.</p>'}
    ${(v.frames || []).length ? `<div class="row-label">🧠 그때 받은 개념도 액자</div><div class="chips">${v.frames.map((f, i) => `<button class="chip past-frame" data-i="${i}">${esc(unitTitle(f.unitId))}</button>`).join('')}</div>` : ''}
    <div class="row-label" style="margin-top:10px">📚 그때 쓴 요약 <small class="muted">${recs.length}개</small></div>
    ${recs.length ? recs.map(x => `<div class="rec"><div class="meta"><b>${shortDate(x.date)}</b><span>${esc(unitTitle(x.unitId))}${topicCode(x.topicId) ? ' · ' + esc(topicCode(x.topicId)) : ''}</span><span class="tag ${x.pass ? 'pass' : 'fail'}">${x.pass ? '통과' : '재도전'}</span><span>${x.score}점</span><span>개념 ${x.opened}개</span></div><div class="text">${esc(x.summary || '')}</div></div>`).join('') : '<p class="muted small">요약이 없어요.</p>'}`;
  const cv = $('#past-canvas');
  if (cv) {
    pastRoom = createRoom(cv, () => v.rooms[rid], { readOnly: () => false, isLocked: () => false, onSelect: () => {}, onChange: () => {}, onWallClick: side => { pastRoom.setView('wall', side); const h = $('#past-hint'); if (h) { h.innerHTML = '<button class="btn tiny" id="past-other">🔄 다른 벽</button> <button class="btn tiny primary" id="past-iso">↩ 방 전체</button>'; $('#past-other').onclick = () => pastRoom.toggleWall(); $('#past-iso').onclick = () => { pastRoom.setView('iso'); h.innerHTML = '<span class="small muted">벽을 클릭하면 액자를 크게 볼 수 있어요.</span>'; }; } } });
  }
  $$('.past-frame').forEach(b => b.onclick = () => { const f = v.frames[+b.dataset.i]; showImageModal(f.img, unitTitle(f.unitId) + ' 개념도'); });
}
async function makeConceptFrame(unitId) {
  const recs = Engine.unitProgress(state, topics, unitId).records;
  const freq = {}, edges = {};
  recs.forEach(r => {
    const hs = (r.hits || []).slice(0, 6);
    hs.forEach(h => freq[h] = (freq[h] || 0) + 1);
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) { const k = [hs[i], hs[j]].sort().join('|'); edges[k] = (edges[k] || 0) + 1; }
  });
  const nodes = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 9).map(e => e[0]);
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 220; const c = cv.getContext('2d');
  c.fillStyle = '#fffdf7'; c.fillRect(0, 0, 320, 220);
  c.fillStyle = '#7a4b00'; c.font = 'bold 13px sans-serif'; c.textAlign = 'center';
  c.fillText(`${state.student.name}의 개념도 · ${unitTitle(unitId).replace(/^[ⅠⅡⅢⅣⅤⅥⅦⅧ]+\.\s*/, '')}`.slice(0, 28), 160, 20);
  const pos = {};
  nodes.forEach((n, i) => { const a = i / nodes.length * Math.PI * 2 - Math.PI / 2; pos[n] = { x: 160 + Math.cos(a) * 110, y: 125 + Math.sin(a) * 78 }; });
  c.strokeStyle = '#d4b483';
  Object.entries(edges).forEach(([k, w]) => { const [a, b] = k.split('|'); if (!pos[a] || !pos[b]) return; c.lineWidth = Math.min(4, w); c.beginPath(); c.moveTo(pos[a].x, pos[a].y); c.lineTo(pos[b].x, pos[b].y); c.stroke(); });
  nodes.forEach((n, i) => {
    const p = pos[n], r = 14 + Math.min(10, freq[n] * 2);
    c.fillStyle = ['#f59e0b', '#4f8fe0', '#5fc8b0', '#9b7fd4', '#f08cb4'][i % 5]; c.beginPath(); c.arc(p.x, p.y, r, 0, 7); c.fill();
    c.fillStyle = '#fff'; c.font = 'bold 11px sans-serif'; c.fillText(n.length > 5 ? n.slice(0, 5) : n, p.x, p.y + 4);
  });
  const r = await dispatch({ type: 'conceptFrame', unitId, img: cv.toDataURL('image/png') }, true);
  if (r.ok) { if (MODE === 'local') saveLocal(); renderLibrary(); toast(`🧠 ${unitTitle(unitId)} 개념도 액자와 🏆 단원 완성 트로피를 받았어요! 내 방 보관함에서 꺼내 놓아 보세요.`, 'ok'); }
}

/* ---------------- 친구 방 (서버 모드) ---------------- */
async function renderFriends() {
  const body = $('#friends-body');
  if (MODE !== 'server') { body.innerHTML = '<div class="card"><h2>🚪 친구 방</h2><p class="muted">친구 방 방문과 영감 스티커는 서버 연동 후 사용할 수 있어요.</p></div>'; return; }
  if (friends.mode === 'visit' && friends.view) return renderVisit();
  body.innerHTML = '<div class="card"><h2>🚪 친구 방</h2><p class="muted small">같은 반 친구의 방을 구경하고, <b>통과한 요약(학습자료)</b>을 읽고 영감 스티커를 남길 수 있어요. 친구의 점수나 실패 기록은 보이지 않아요.</p><p class="muted">불러오는 중...</p></div>';
  try {
    const r = await API.call({ action: 'classmates' });
    if (!r.ok) return handleServerError(r);
    friends.list = r.list || [];
    const icon = { open: '🟢 열려 있음', knock: '🟡 노크 필요', private: '🔴 나만 보기' };
    const t = isTeacher();
    body.innerHTML = `<div class="card"><h2>${t ? '👩‍🏫 학생 방 둘러보기' : '🚪 친구 방'}</h2><p class="muted small">${t ? '교사는 모든 학생의 방과 <b>통과한 요약(학습자료)</b>을 볼 수 있어요. 점수·시도 횟수는 평가기록부 시트에서 확인하세요.' : `같은 반 친구의 방을 구경하고, <b>통과한 요약(학습자료)</b>을 읽고 영감 스티커를 남길 수 있어요. (스티커 1개당 🪙 ${CONFIG.sticker.coin}, 하루 ${CONFIG.sticker.perDay}번)`}</p>
      ${friends.list.length ? friends.list.map(f => `<div class="friend-row"><span class="name">${esc(f.name)}</span><span class="priv">${icon[f.privacy] || ''}</span>
        ${f.privacy === 'private' && !t ? '<button class="btn tiny" disabled>방문 불가</button>' : `<button class="btn primary tiny visit" data-id="${esc(f.id)}">${t || f.privacy === 'open' ? '방문하기' : '노크 / 들어가기'}</button>`}</div>`).join('') : `<p class="muted">${t ? '아직 가입한 학생이 없어요.' : '아직 같은 반 친구가 가입하지 않았어요.'}</p>`}</div>`;
    $$('.visit').forEach(b => b.onclick = () => visitFriend(b.dataset.id));
  } catch (e) { body.innerHTML = '<div class="card"><p class="muted">서버에 연결할 수 없어요.</p></div>'; }
}
async function visitFriend(id) {
  try {
    const r = await API.call({ action: 'visit', targetId: id });
    if (!r.ok) return handleServerError(r);
    if (r.status === 'ok') { friends = Object.assign(friends, { mode: 'visit', target: id, view: r.view, myStickers: r.myStickers || [], roomId: Object.keys(r.view.rooms)[0] || null }); return renderVisit(); }
    if (r.status === 'pending') return toast('노크했어요! 친구가 문을 열어주면 들어갈 수 있어요. 잠시 후 다시 눌러 보세요.');
    if (r.status === 'private') return toast('이 친구는 방을 닫아 두었어요', 'bad');
    const k = await API.call({ action: 'knock', targetId: id });
    if (k.ok) toast(k.status === 'allowed' ? '들어갈 수 있어요! 다시 눌러 보세요' : '똑똑! 노크했어요. 친구가 문을 열어주면 들어갈 수 있어요.');
    else handleServerError(k);
  } catch (e) { toast('인터넷 연결을 확인해 주세요', 'bad'); }
}
function renderVisitHint() {
  let el = $('#visit-hint'); if (!el || !visitRoom) return;
  const v = visitRoom.getView();
  el.innerHTML = v.mode === 'wall'
    ? `<span class="small">${v.wall === 'R' ? '오른쪽 벽' : '왼쪽 벽'}</span> <button class="btn tiny" id="v-other-wall">🔄 다른 벽</button> <button class="btn tiny primary" id="v-iso">↩ 방 전체</button>`
    : '<span class="small muted">벽을 클릭하면 액자를 크게 볼 수 있어요. (구경만 가능)</span>';
  const a = $('#v-other-wall'); if (a) a.onclick = () => { visitRoom.toggleWall(); renderVisitHint(); };
  const b = $('#v-iso'); if (b) b.onclick = () => { visitRoom.setView('iso'); renderVisitHint(); };
}
function renderVisit() {
  const v = friends.view; const ids = Object.keys(v.rooms);
  if (!friends.roomId || !ids.includes(friends.roomId)) friends.roomId = ids[0];
  $('#friends-body').innerHTML = `<div class="card"><div class="btn-row" style="margin:0 0 8px"><button class="btn ghost tiny" id="visit-back">← 친구 목록</button></div>
    <h2>🏠 ${esc(v.name)}의 방</h2>
    ${ids.length > 1 ? `<div class="room-tabs">${ids.map(id => `<button class="room-tab ${id === friends.roomId ? 'on' : ''}" data-id="${esc(id)}">${esc(unitTitle(id))}</button>`).join('')}</div>` : ''}
    ${ids.length ? '<canvas id="visit-canvas" width="820" height="640"></canvas><div class="room-hint" id="visit-hint"></div>' : '<p class="muted">아직 꾸민 방이 없어요.</p>'}</div>
    <div class="card"><h3>📚 ${esc(v.name)}의 학습자료 <small class="muted">통과한 요약만 보여요</small></h3>
    ${v.summaries.length ? v.summaries.slice().reverse().map(s => `<div class="summary-card"><div class="meta"><span>${shortDate(s.date)} · ${esc(unitTitle(s.unitId))}${topicCode(s.topicId) ? ' · ' + esc(topicCode(s.topicId)) : ''}</span>
      ${friends.myStickers.includes(s.key) ? '<span class="tag best">✨ 스티커 남김</span>' : `<button class="btn tiny accent sticker" data-key="${esc(s.key)}">✨ 영감 스티커</button>`}</div><div>${esc(s.text)}</div></div>`).join('') : '<p class="muted">아직 학습자료가 없어요.</p>'}</div>${isTeacher() ? teacherVisitCard(v) : ''}`;
  $('#visit-back').onclick = () => { friends.mode = 'list'; friends.view = null; visitRoom = null; renderFriends(); };
  $$('#friends-body .room-tab').forEach(b => b.onclick = () => { friends.roomId = b.dataset.id; renderVisit(); });
  const cv = $('#visit-canvas');
  if (cv) {
    visitRoom = createRoom(cv, () => friends.view.rooms[friends.roomId], { readOnly: () => false, isLocked: () => false, onSelect: () => {}, onChange: () => {}, onWallClick: side => { visitRoom.setView('wall', side); renderVisitHint(); } });
    renderVisitHint();
  }
  $$('.sticker').forEach(b => b.onclick = async () => {
    const r = await API.call({ action: 'sticker', targetId: friends.target, key: b.dataset.key }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) { friends.myStickers.push(b.dataset.key); if (r.coins) { state.coins = r.coins; updateHeader(); } toast(r.message || '영감 스티커를 남겼어요!', 'ok'); renderVisit(); }
    else toast(r.message || '실패했어요', 'bad');
  });
}

/* ---------------- 상점 ---------------- */
function renderShop() {
  const room = currentRoom(); const hasFrame = room.inventory.some(i => i.id === 'photo_frame' && !i.img);
  $('#shop-body').innerHTML = `
    <div class="card"><h2>🛒 상점</h2><p class="muted small">코인은 요약을 통과하면 받아요. 색상·스타일 리폼은 내 방에서 가구를 선택해 할 수 있어요. 산 액자와 가구는 내 방 보관함에 들어가요.</p></div>
    ${isTeacher() ? '<div class="card" id="t-photo-approvals" style="background:#eef6ff"><h3>✅ 사진 액자 승인 대기</h3><p class="muted small">불러오는 중...</p></div><div class="card" id="t-coupon-approvals" style="background:#eef6ff"><h3>✅ 쿠폰 승인 대기</h3><p class="muted small">불러오는 중...</p></div><div class="card" id="t-coupons" style="background:#eef6ff"></div><div class="card" id="t-items" style="background:#eef6ff"></div><div class="card" id="t-prices" style="background:#eef6ff"></div>' : ''}
    <h3>🖼️ 특별 아이템</h3>
    <div class="shop-grid"><div class="card shop-item"><div class="emoji">📷</div><b>커스텀 사진 액자</b><p class="small muted">빈 액자를 사서 사진을 올려요. 개인정보·초상권·저작권 확인 후 올릴 수 있고, 선생님이 승인하면 컬러로 전시돼요. (월 1회)</p>
      <div class="price">🪙 ${ITEMS.photo_frame.cost}</div><button class="btn primary" id="buy-frame" ${hasFrame ? 'disabled' : ''}>${hasFrame ? '빈 액자 보유 중' : '구매'}</button></div></div>
    <h3 style="margin-top:14px">🪑 가구 상점 <small class="muted">— 산 가구는 내 방 보관함에 들어가요</small></h3>
    <div class="shop-grid">${Object.keys(ITEMS).filter(k => (ITEMS[k].pool === 'box' || ITEMS[k].pool === 'shop') && k !== 'photo_frame').map(k => { const d = ITEMS[k], r = RARITY[d.rarity], p = d.cost > 0 ? d.cost : ((CONFIG.shopPrice || {})[d.rarity] || 100); return `<div class="card shop-item"><div class="emoji">${d.emoji || '🪑'}</div><b>${esc(d.name)}</b> <span class="rar small" style="color:${r.color}">${r.name}</span><div class="price">🪙 ${p}</div>${isTeacher() && !d.custom ? `<label class="small" style="margin:4px 0 6px">가격 <input type="number" min="0" class="item-price" data-id="${k}" value="${itemPrices[k] || ''}" placeholder="${(CONFIG.shopPrice || {})[d.rarity] || 100}"></label>` : ''}<button class="btn primary buy-item" data-id="${k}">구매</button></div>`; }).join('')}</div>${isTeacher() ? '<div class="btn-row"><button class="btn primary" id="save-item-prices">가구별 가격 저장</button><span class="muted small">비우면 희귀도 기본가로 돌아가요. 교사가 추가한 가구는 가구 추가 칸에서 가격을 정해요.</span></div>' : ''}
    <h3 style="margin-top:14px">🎟️ O2O 비밀 상점 <small class="muted">— 현실 교실 쿠폰 (선생님 승인 후 사용)</small></h3>
    <div class="shop-grid">${coupons.map(cp => `<div class="card shop-item"><div class="emoji">🎟️</div><b>${esc(cp.name)}</b><p class="small muted">${esc(cp.desc)}</p><div class="price">🪙 ${cp.cost}</div><button class="btn primary buy-coupon" data-id="${cp.id}">구매</button></div>`).join('')}</div>
    ${isTeacher() ? '' : `<div class="card" style="margin-top:14px"><h3>내 쿠폰</h3>${state.coupons.length ? state.coupons.map(c => `<div class="rec"><b>${esc(c.name)}</b> <span class="muted small">${shortDate(c.date)}</span> <span class="tag ${c.status === 'approved' ? 'pass' : (c.status === 'used' || c.status === 'rejected') ? 'fail' : 'best'}">${{ pending: '승인 대기', approved: '사용 가능', used: '사용 완료', rejected: '거절됨 (코인 환불)' }[c.status] || c.status}</span></div>`).join('') : '<p class="muted small">아직 쿠폰이 없어요.</p>'}</div>`}`;
  if (isTeacher()) {
    tAdmin.coupons = coupons.map(c => Object.assign({}, c)); renderTCoupons(); tAdmin.items = customItems.map(x => Object.assign({}, x)); renderTItems(); loadTApprovals(); renderTPrices();
    const sip = $('#save-item-prices'); if (sip) sip.onclick = async () => { const prices = {}; $$('.item-price').forEach(i => { if (i.value !== '') prices[i.dataset.id] = Number(i.value); }); const r = await API.call({ action: 'saveItemPrices', prices }).catch(() => ({ ok: false, message: '연결 실패' })); if (r.ok) { applyItemPrices(r.itemPrices); toast('가구별 가격을 저장했어요', 'ok'); renderShop(); } else toast(r.message || '실패했어요', 'bad'); };
  }
  const bf = $('#buy-frame'); if (bf) bf.onclick = async () => { const r = await dispatch({ type: 'buyFrame', unitId: currentRoomId }, true); if (r.ok) { renderShop(); toast('빈 액자를 샀어요! 내 방 보관함에서 벽에 걸고 사진을 올려 보세요.', 'ok'); } };
  $$('.buy-item').forEach(b => b.onclick = async () => { const r = await dispatch({ type: 'buyItem', unitId: currentRoomId, itemId: b.dataset.id }, true); if (r.ok) { toast(`${ITEMS[b.dataset.id].name}을(를) 샀어요! 내 방 보관함에서 놓을 수 있어요.`, 'ok'); renderShop(); } });
  $$('.buy-coupon').forEach(b => b.onclick = async () => { const r = await dispatch({ type: 'buyCoupon', id: b.dataset.id }, true); if (r.ok) { renderShop(); toast('쿠폰을 신청했어요. 선생님 승인을 기다려요!', 'ok'); } });
}

/* ---------------- 교사 ---------------- */
function renderTeacher() {
  const body = $('#teacher-body');
  if (MODE === 'server') {
    if (isTeacher()) { renderTeacherServer(body); return; }
    body.innerHTML = `<div class="card"><h2>🍎 교사 안내</h2>
      <p>교사 기능은 로그인 화면의 <b>교사로 접속</b>(스터디룸 DB 시트 메뉴 ⑧에서 받은 8자리 코드)으로 들어오면 이 탭에 나타나요. 형성평가 문항 관리, 쿠폰 관리, 심야 잠금·이벤트·가입 코드 설정을 할 수 있어요.</p>
      <p class="muted small">사진·쿠폰 승인과 평가기록부는 스터디룸 DB 시트에서 봐요. 학생의 개인정보와 학습 내용은 교사가 지정한 폴더에만 저장되고 외부로 전송되지 않아요.</p></div>`;
    return;
  }
  if (!teacherOpen) {
    body.innerHTML = `<div class="card"><h2>🍎 교사 모드 (로컬 시연용)</h2><label>PIN <input type="text" id="pin" inputmode="numeric" placeholder="PIN 입력"></label><button class="btn primary" id="pin-btn">열기</button><p class="muted small">서버 모드에서는 PIN 대신 구글 계정 + 관리자 승인으로 교사를 인증해요.</p></div>`;
    $('#pin-btn').onclick = () => { if ($('#pin').value === CONFIG.teacherPin) { teacherOpen = true; renderTeacher(); } else toast('PIN이 달라요', 'bad'); };
    return;
  }
  const dates = Array.from(new Set(state.records.map(r => r.date))).sort();
  const cell = d => state.records.filter(r => r.date === d).map(r => `<div><b>${esc(unitTitle(r.unitId))} ${esc(topicCode(r.topicId))}</b> ${r.pass ? '✅' : '❌'} ${r.score}점 · 퀴즈 ${r.quiz ? r.quiz.correct + '/' + r.quiz.total : '-'} · ${r.attempts}회<br><span class="muted">${esc(r.summary)}</span></div>`).join('<hr>');
  const photos = []; Object.entries(state.rooms).forEach(([rid, r]) => r.inventory.forEach(i => { if (i.id === 'photo_frame' && i.img && !i.approved) photos.push({ rid, it: i }); }));
  const coupons = state.coupons.filter(c => c.status === 'pending');
  body.innerHTML = `
    <div class="card"><h2>📋 평가기록부 <small class="muted">(행: 학번 · 열: 날짜 — 서버 모드의 마스터 시트와 같은 구조)</small></h2>
      <div class="sheet-wrap"><table class="sheet"><thead><tr><th>학번</th><th>이름</th>${dates.map(d => `<th>${shortDate(d)}</th>`).join('')}</tr></thead>
      <tbody><tr><td>${esc(state.student.id)}</td><td>${esc(state.student.name)}</td>${dates.map(d => `<td>${cell(d)}</td>`).join('')}</tr></tbody></table></div>
      <div class="btn-row"><button class="btn" id="btn-csv">⬇️ CSV 내보내기</button></div></div>
    <div class="card"><h3>✅ 승인 대기 <small class="muted">(일괄 승인 지원)</small></h3>
      ${photos.length + coupons.length === 0 ? '<p class="muted small">대기 중인 요청이 없어요.</p>' : ''}
      ${photos.map(p => `<div class="approval"><img src="${p.it.img}"><div>📷 사진 액자 (${esc(unitTitle(p.rid))} 방)</div><button class="btn primary approve-photo" data-rid="${esc(p.rid)}" data-uid="${p.it.uid}">승인</button></div>`).join('')}
      ${coupons.map(c => `<div class="approval"><div>🎟️ ${esc(c.name)} <span class="muted small">${shortDate(c.date)}</span></div><button class="btn primary approve-coupon" data-i="${state.coupons.indexOf(c)}">승인</button></div>`).join('')}
      ${photos.length + coupons.length > 0 ? '<div class="btn-row"><button class="btn accent" id="approve-all">모두 승인 (Batch)</button></div>' : ''}</div>
    <div class="card"><h3>⚙️ 설정</h3>
      <label class="toggle"><input type="checkbox" id="t-bypass" ${state.settings.bypassLock ? 'checked' : ''}> 시간 잠금 해제 (시연/테스트용)</label>
      <label class="toggle"><input type="checkbox" id="t-event" ${state.settings.eventForce ? 'checked' : ''}> 이벤트 강제 활성화 (${esc(CONFIG.event.name)})</label>
      <div class="btn-row"><button class="btn" id="t-coins">🪙 코인 +200 (시연용)</button><button class="btn danger" id="t-reset">이 기기 데이터 초기화</button><button class="btn ghost" id="t-close">교사 모드 닫기</button></div></div>`;
  $('#btn-csv').onclick = () => {
    const rows = [['학번', '이름', '날짜', '단원', '통과', '점수', '퀴즈', '시도', '요약']];
    state.records.forEach(r => rows.push([state.student.id, state.student.name, r.date, unitTitle(r.unitId), r.pass ? 'O' : 'X', r.score, r.quiz ? `${r.quiz.correct}/${r.quiz.total}` : '', r.attempts, r.summary]));
    const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `평가기록부_${state.student.id}.csv`; a.click();
  };
  $$('.approve-photo').forEach(b => b.onclick = () => { state.rooms[b.dataset.rid].inventory.find(i => i.uid === +b.dataset.uid).approved = true; saveLocal(); renderTeacher(); });
  $$('.approve-coupon').forEach(b => b.onclick = () => { state.coupons[+b.dataset.i].status = 'approved'; saveLocal(); renderTeacher(); });
  const aa = $('#approve-all'); if (aa) aa.onclick = () => { photos.forEach(p => p.it.approved = true); coupons.forEach(c => c.status = 'approved'); saveLocal(); renderTeacher(); toast('모두 승인했어요', 'ok'); };
  $('#t-bypass').onchange = e => { state.settings.bypassLock = e.target.checked; saveLocal(); checkLocks(); };
  $('#t-event').onchange = e => { state.settings.eventForce = e.target.checked; saveLocal(); };
  $('#t-coins').onclick = () => { state.coins += 200; saveLocal(); toast('+200 코인', 'ok'); };
  $('#t-close').onclick = () => { teacherOpen = false; showScreen('room'); };
  $('#t-reset').onclick = () => { if (confirm('이 기기의 모든 기록·가구·코인을 삭제할까요?')) { localStorage.removeItem(STORAGE_KEY); location.reload(); } };
}

/* ---------------- 교사 모드 (서버) : 설정 · 쿠폰 · 문항 관리 ---------------- */
let tAdmin = { settings: null, coupons: null, unitId: null, topicId: null, questions: null, source: '' };
async function renderTeacherServer(body) {
  body.innerHTML = `
    <div class="card" style="background:#eef6ff"><h3>👩‍🏫 교사로 접속 중</h3><p class="small">심야·수업 시간 잠금이 적용되지 않고 코인은 무제한이에요. 친구 방 탭에서 모든 학생의 방과 학습자료를 볼 수 있어요. 이 계정의 방은 시험용이라 평가기록부에 들어가지 않아요.</p></div>
    <div class="card"><h3>🔑 교사 비밀번호 바꾸기 <small class="muted">— 이메일 로그인에 쓰는 비밀번호</small></h3>
      <div class="field-row"><label style="flex:1 1 160px">새 비밀번호 (6자 이상) <input type="password" id="t-pw1" maxlength="40" autocomplete="new-password"></label><label style="flex:1 1 160px">한 번 더 <input type="password" id="t-pw2" maxlength="40" autocomplete="new-password"></label><button class="btn primary" id="t-pw-save" style="margin-bottom:1px">저장</button></div>
      <p class="muted small">내 이메일: <b>${esc((API.getSession() || {}).id || '').replace(/^T:/, '')}</b> · 잊으면 시트 메뉴 ⑧의 접속 코드로 들어와 다시 정하거나 관리자에게 물어보면 돼요.</p>
      <div class="notice small">⚠️ 교사 비밀번호는 관리자가 확인할 수 있어요. 은행·포털 등 다른 곳에서 쓰는 중요한 비밀번호는 쓰지 말고, 이 앱 전용 비밀번호를 정해 주세요.</div></div>
    <div class="card" id="t-settings"><h3>⚙️ 설정</h3><p class="muted small">불러오는 중...</p></div>
    <div class="card"><h3>🪙 코인 일괄 지급</h3><p class="muted small">전체 학생 또는 학번 목록에 코인을 한 번에 더해요. (학급 협동 미션 달성, 행사 보상 등)</p><div class="btn-row" style="align-items:flex-end"><label style="margin:0;width:120px">금액 <input type="number" id="t-grant-amt" min="1" max="10000" value="100"></label><label style="margin:0;flex:1;min-width:220px">대상 학번 <input type="text" id="t-grant-ids" placeholder="비우면 전체 학생 · 여러 명은 쉼표로 (예: 10301, 10302)" autocomplete="off"></label><button class="btn primary" id="t-grant">지급</button></div></div>
    ${isAdmin() ? '<div class="card" id="t-teachers" style="background:#fff7ed"><h3>👩‍🏫 교사 등록·승인</h3><p class="muted small">불러오는 중...</p></div>' : ''}
    <div class="card" id="t-events"><h3>🎉 이벤트 관리</h3></div>
    <div class="card"><h3>🧪 테스트 자료 넣기</h3><p class="muted small">학번을 넣고 누르면 그 학생에게 한 단원의 성취기준을 모두 통과한 기록이 들어가요. 학생 서재의 <b>개념도 액자 만들기</b>를 바로 시험할 수 있어요. (실제 학생에게는 쓰지 마세요)</p><div class="btn-row"><input type="text" id="t-seed-id" inputmode="numeric" placeholder="학번 (예: 7777)" style="max-width:160px" autocomplete="off"><button class="btn" id="t-seed">단원 통과 기록 넣기</button></div></div>
    <div class="card"><h3>📝 문항 · 🎟️ 쿠폰 · ✅ 승인은 어디서?</h3><p class="small">형성평가 문항은 <b>학습하기 탭</b>에서 성취기준을 열면 형성평가 아래에 편집기가 나와요. 쿠폰 편집과 쿠폰·사진 액자 승인은 <b>상점 탭</b> 위에 있어요.</p></div>
    <div class="card"><h3>📌 시트에서 하는 일</h3><ul class="small">
      <li><b>사진·쿠폰 승인</b>: 승인요청 시트의 승인 체크박스를 켜면 학생이 다음 접속 때 반영돼요. (즉시 반영은 메뉴 ④)</li>
      <li><b>평가기록부</b>: 행=학번, 열=날짜. 10분마다 자동 갱신돼요. (즉시 갱신은 메뉴 ③)</li>
      <li><b>단원·핵심 개념·오개념</b>: 단원 시트. 문항은 문항 시트 또는 아래 문항 관리에서 고쳐요.</li>
      <li><b>교사 추가</b>: 관리자는 위 교사 등록·승인 칸(또는 메뉴 ⑥) / <b>학생 비밀번호 초기화</b>: 메뉴 ⑤ / <b>백업</b>: 드라이브 폴더 사본</li>
      <li><b>코드 수정</b>: 앱은 git push, 서버는 <code>npm run server</code> 한 줄로 자동 배포돼요. Apps Script 편집기는 열지 않아도 돼요.</li></ul></div>`;
  try {
    const r = await API.call({ action: 'getSettings' }); if (!r.ok) throw new Error(r.message || r.error);
    tAdmin.settings = r.settings; renderTSettings();
  } catch (e) { $('#t-settings').innerHTML = '<h3>⚙️ 설정</h3><p class="muted small">불러오지 못했어요: ' + esc(e.message) + '</p>'; }
  tAdmin.events = events.map(e => Object.assign({}, e, { itemIds: (e.itemIds || []).slice() })); renderTEvents();
  if (isAdmin()) loadTTeachers();
  $('#t-grant').onclick = async () => {
    const amount = Number($('#t-grant-amt').value); const ids = $('#t-grant-ids').value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
    if (!(amount >= 1)) return toast('금액을 입력해 주세요', 'bad');
    if (!confirm((ids.length ? ids.length + '명' : '전체 학생') + '에게 🪙 ' + amount + '씩 지급할까요?')) return;
    const r = await API.call({ action: 'grantCoins', amount, ids }, { timeout: 120000 }).catch(() => ({ ok: false, message: '연결 실패' }));
    toast(r.ok ? r.message : (r.message || '실패했어요'), r.ok ? 'ok' : 'bad');
  };
  $('#t-seed').onclick = async () => { const id = $('#t-seed-id').value.trim(); if (!id) return toast('학번을 입력해 주세요', 'bad'); const r = await API.call({ action: 'seedTest', studentId: id }).catch(() => ({ ok: false, message: '연결 실패' })); toast(r.ok ? r.message : (r.message || '실패했어요'), r.ok ? 'ok' : 'bad'); };
  loadTApprovals();
}
function renderTEvents() {
  const list = tAdmin.events; const box = $('#t-events'); if (!box) return;
  const itemOpts = Object.keys(ITEMS).filter(k => ITEMS[k].pool !== 'special');
  box.innerHTML = `<h3>🎉 이벤트 관리 <small class="muted">— 기간 중 요약 통과 시 한정 가구가 드롭돼요</small></h3>
    ${list.map((e, i) => `<div class="summary-card"><div class="meta"><b>이벤트 ${i + 1}</b><button class="btn tiny danger te-del" data-i="${i}">삭제</button></div>
      <label>이름 <input type="text" data-i="${i}" data-k="name" value="${esc(e.name)}" maxlength="30" placeholder="예: 부여 백제문화제 특별 주간"></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><label style="flex:1">시작일 <input type="date" data-i="${i}" data-k="start" value="${esc(e.start)}"></label><label style="flex:1">종료일 <input type="date" data-i="${i}" data-k="end" value="${esc(e.end)}"></label><label style="width:120px">드롭 확률(%) <input type="text" inputmode="numeric" data-i="${i}" data-k="rate" value="${Math.round((e.dropRate || 0) * 100)}"></label></div>
      <div class="row-label">한정 가구 (통과 시 이 중 하나가 드롭)</div><div class="chips">${itemOpts.map(k => `<label class="chip ${(e.itemIds || []).includes(k) ? 'on' : ''}" style="cursor:pointer"><input type="checkbox" data-i="${i}" data-item="${k}" ${(e.itemIds || []).includes(k) ? 'checked' : ''} style="display:none">${ITEMS[k].emoji} ${esc(ITEMS[k].name)}</label>`).join('')}</div>
      <label class="toggle"><input type="checkbox" data-i="${i}" data-k="force" ${e.force ? 'checked' : ''}> 기간과 상관없이 지금 바로 활성화</label></div>`).join('')}
    ${list.length ? '' : '<p class="muted small">이벤트가 없어요.</p>'}
    <div class="btn-row"><button class="btn" id="te-add">+ 이벤트 추가</button><button class="btn primary" id="te-save">이벤트 저장</button></div>`;
  const sync = () => {
    $$('#t-events input[data-k]').forEach(el => { const e = list[+el.dataset.i]; if (!e) return; const k = el.dataset.k; if (k === 'force') e.force = el.checked; else if (k === 'rate') e.dropRate = Math.min(1, Math.max(0, (Number(el.value) || 0) / 100)); else e[k] = el.value; });
    list.forEach((e, i) => { e.itemIds = $$(`#t-events input[data-item][data-i="${i}"]`).filter(c => c.checked).map(c => c.dataset.item); });
  };
  $$('#t-events input[data-item]').forEach(c => c.onchange = () => c.parentElement.classList.toggle('on', c.checked));
  $$('.te-del').forEach(b => b.onclick = () => { sync(); list.splice(+b.dataset.i, 1); renderTEvents(); });
  $('#te-add').onclick = () => { sync(); const t = todayKey(); list.push({ id: 'ev' + Date.now().toString(36), name: '', start: t, end: t, itemIds: [], dropRate: 0.35, force: false }); renderTEvents(); };
  $('#te-save').onclick = async () => {
    sync();
    if (list.some(e => e.name.trim() && !e.itemIds.length)) return toast('한정 가구를 하나 이상 골라 주세요', 'bad');
    const r = await API.call({ action: 'saveEvents', events: list }).catch(e => ({ ok: false, message: '연결 실패: ' + e.message }));
    if (r.ok) { events = r.events; tAdmin.events = events.map(e => Object.assign({}, e, { itemIds: e.itemIds.slice() })); renderTEvents(); updateHeader(); toast(`이벤트 ${events.length}개를 저장했어요`, 'ok'); }
    else toast('저장 실패: ' + (r.message || r.error || '알 수 없는 오류'), 'bad');
  };
}
async function loadTApprovals() {
  const box = $('#t-photo-approvals') || $('#t-coupon-approvals'); if (!box) return;
  try { const r = await API.call({ action: 'approvals' }); if (!r.ok) throw new Error(r.message || r.error); tAdmin.approvals = r.list || []; renderTApprovals(); }
  catch (e) { box.innerHTML = '<h3>✅ 승인 대기</h3><p class="muted small">불러오지 못했어요: ' + esc(e.message) + '</p>'; }
  // 컨테이너 없는 쪽은 renderTApprovals 가 건너뜀
}
function renderTApprovals() {
  renderTApprovalList('#t-photo-approvals', 'photo', '✅ 사진 액자 승인 대기', '📷 학생이 올린 커스텀 사진 액자예요. 개인정보·초상권·저작권에 문제가 없는지 보고 승인하면 컬러로 전시돼요.');
  renderTApprovalList('#t-coupon-approvals', 'coupon', '✅ 쿠폰 승인 대기', '학생이 코인으로 신청한 교실 쿠폰이에요. 승인하면 학생 상점에 "사용 가능"으로 표시돼요.');
}
function renderTApprovalList(sel, type, title, note) {
  const box = $(sel); if (!box) return;
  const list = (tAdmin.approvals || []).filter(a => a.type === type);
  box.innerHTML = `<h3>${title} <small class="muted">${list.length}건</small></h3><p class="muted small">${esc(note)}</p>` +
    (list.length ? list.map(a => `<div class="approval">${a.type === 'photo' ? (a.img ? `<img src="${a.img}" style="filter:none;width:96px;height:64px">` : '<span class="muted small">사진 없음</span>') : '<span style="font-size:1.6rem">🎟️</span>'}
      <div style="flex:1"><b>${emojiFor(a.id)} ${esc(a.name)}</b> <small class="muted">${esc(a.id)} · ${esc(a.time)}</small><br><span class="small">${a.type === 'photo' ? '📷 커스텀 사진 액자' : esc(a.desc)}</span></div>
      <button class="btn primary tiny ta-ok" data-row="${a.row}">승인</button><button class="btn tiny danger ta-no" data-row="${a.row}">거절</button></div>`).join('') +
      `<div class="btn-row"><button class="btn accent ta-all">모두 승인 (${list.length})</button><button class="btn ghost ta-refresh">새로 고침</button></div>` : '<p class="muted small">대기 중인 요청이 없어요.</p><div class="btn-row"><button class="btn ghost ta-refresh">새로 고침</button></div>');
  const act = async (rows, decision) => {
    const r = await API.call({ action: 'approve', rows, decision }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) { tAdmin.approvals = r.list || []; renderTApprovals(); toast(decision === 'reject' ? '거절했어요' : '승인했어요. 학생 화면에 바로 반영돼요', 'ok'); } else toast(r.message || '실패했어요', 'bad');
  };
  box.querySelectorAll('.ta-ok').forEach(b => b.onclick = () => act([+b.dataset.row], 'approve'));
  box.querySelectorAll('.ta-no').forEach(b => b.onclick = () => { if (confirm(type === 'photo' ? '거절할까요? 사진은 지워지고 학생이 다시 올릴 수 있어요.' : '거절할까요? 쿠폰 코인은 학생에게 돌려줘요.')) act([+b.dataset.row], 'reject'); });
  const all = box.querySelector('.ta-all'); if (all) all.onclick = () => act(list.map(a => a.row), 'approve');
  box.querySelectorAll('.ta-refresh').forEach(b => b.onclick = loadTApprovals);
}
function renderTSettings() {
  const s = tAdmin.settings;
  $('#t-settings').innerHTML = `<h3>⚙️ 설정 <small class="muted">(모든 학생에게 적용)</small></h3>
    <label class="toggle"><input type="checkbox" id="ts-night" ${s.nightLockOff ? 'checked' : ''}> 심야 잠금 해제 (밤 10시~아침 7시에도 학생 접속 허용)</label>
    <label class="toggle"><input type="checkbox" id="ts-event" ${s.eventForce ? 'checked' : ''}> 모든 이벤트 강제 활성화 (기간과 상관없이 한정 가구 드롭)</label>
    <label class="toggle"><input type="checkbox" id="ts-class" ${s.classLock && s.classLock.enabled ? 'checked' : ''}> 수업 시간 방 꾸미기 잠금 (이 시간에는 학습하기만 가능)</label>
    <div style="display:flex;gap:8px;align-items:center;margin:0 0 10px 26px" class="small">잠금 시간 <input type="number" id="ts-cstart" min="0" max="23" value="${s.classLock ? s.classLock.start : 9}" style="width:70px"> 시 ~ <input type="number" id="ts-cend" min="1" max="24" value="${s.classLock ? s.classLock.end : 16}" style="width:70px"> 시 <span class="muted">(예: 9 ~ 16)</span></div>
    <label>가입 코드 <input type="text" id="ts-join" value="${esc(s.joinCode)}" placeholder="비우면 누구나 가입할 수 있어요" maxlength="40"></label>
    <div class="row-label" style="margin-top:12px">🎁 보상 (코인) <small class="muted">— 가구·리폼 가격은 상점 탭에서 조절해요</small></div>
    <div class="chips">${[['conceptCoin','개념 1개 열림'],['quizCoin','퀴즈 정답 1개'],['passCoin','요약 통과'],['firstTryBonus','첫 시도 통과'],['monsterBonus','괴물 정화'],['stickerCoin','영감 스티커']].map(([k, n]) => `<label class="small" style="display:flex;align-items:center;gap:4px;margin:0">${n} <input type="number" min="0" data-price="${k}" value="${(s.prices || {})[k] ?? ''}" style="width:76px;padding:6px 8px"></label>`).join('')}</div>
    <div class="btn-row"><button class="btn primary" id="ts-save">설정 저장</button></div>`;
  $('#ts-save').onclick = async () => {
    const prices = {}; $$('#t-settings input[data-price]').forEach(i => { if (i.value !== '') prices[i.dataset.price] = Number(i.value); });
    const settings = { nightLockOff: $('#ts-night').checked, eventForce: $('#ts-event').checked, joinCode: $('#ts-join').value.trim(), classLock: { enabled: $('#ts-class').checked, start: Number($('#ts-cstart').value), end: Number($('#ts-cend').value) }, prices };
    const r = await API.call({ action: 'saveSettings', settings }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) { tAdmin.settings = r.settings; serverSettings = { nightLockOff: r.settings.nightLockOff, classLock: r.settings.classLock, prices: r.settings.prices }; applyPricing(r.settings.prices); checkLocks(); toast('설정을 저장했어요. 가격은 바로, 학생에게는 1분 내 반영돼요', 'ok'); } else toast(r.message || '실패했어요', 'bad');
  };
}
function renderTCoupons() {
  const list = tAdmin.coupons;
  if (!$('#t-coupons')) return;
  $('#t-coupons').innerHTML = `<h3>🎟️ 쿠폰 관리 <small class="muted">— 교사에게만 보여요 · 저장하면 아래 상점에 바로 반영</small></h3>
    <div class="sheet-wrap"><table class="sheet"><thead><tr><th>이름</th><th>코인</th><th>설명</th><th></th></tr></thead><tbody>
    ${list.map((c, i) => `<tr><td><input type="text" data-i="${i}" data-k="name" value="${esc(c.name)}" maxlength="20" placeholder="예: 자리 선택권"></td><td><input type="text" inputmode="numeric" data-i="${i}" data-k="cost" value="${c.cost}" style="width:80px"></td><td><input type="text" data-i="${i}" data-k="desc" value="${esc(c.desc)}" maxlength="60" placeholder="설명"></td><td><button class="btn tiny danger tc-del" data-i="${i}">삭제</button></td></tr>`).join('')}
    </tbody></table></div>
    ${list.length ? '' : '<p class="muted small">쿠폰이 없어요. 추가해 보세요.</p>'}
    <div class="btn-row"><button class="btn" id="tc-add">+ 쿠폰 추가</button><button class="btn primary" id="tc-save">쿠폰 저장</button></div>`;
  const sync = () => $$('#t-coupons input[data-i]').forEach(inp => { const c = list[+inp.dataset.i]; if (!c) return; c[inp.dataset.k] = inp.dataset.k === 'cost' ? (Number(inp.value) || 0) : inp.value; });
  $$('.tc-del').forEach(b => b.onclick = () => { sync(); list.splice(+b.dataset.i, 1); renderTCoupons(); });
  $('#tc-add').onclick = () => { sync(); list.push({ id: 'cp' + Date.now().toString(36), name: '', cost: 100, desc: '' }); renderTCoupons(); };
  $('#tc-save').onclick = async () => {
    sync();
    if (!list.some(c => c.name.trim())) return toast('쿠폰 이름을 입력해 주세요', 'bad');
    const r = await API.call({ action: 'saveCoupons', coupons: list }).catch(e => ({ ok: false, message: '연결 실패: ' + e.message }));
    if (r.ok) { coupons = r.coupons; tAdmin.coupons = coupons.map(c => Object.assign({}, c)); toast(`쿠폰 ${coupons.length}개를 저장했어요. 학생 상점에 바로 반영돼요`, 'ok'); renderShop(); }
    else toast('저장 실패: ' + (r.message || r.error || '알 수 없는 오류'), 'bad');
  };
}
function renderTQuestions(fixed) {
  const box = $('#t-questions'); if (!box) return;
  const u = unitOf(tAdmin.unitId) || units[0]; tAdmin.unitId = u ? u.id : null;
  const t = u && (u.topics.find(x => x.id === tAdmin.topicId) || u.topics[0]); tAdmin.topicId = t ? t.id : null;
  box.innerHTML = `<h3>✏️ 이 형성평가 문항 수정 <small class="muted">— 교사에게만 보여요 · ${esc(t ? t.code || '' : '')}</small></h3>
    <div id="tq-list" style="margin-top:10px"><p class="muted small">불러오는 중...</p></div>`;
  if (!t) { $('#tq-list').innerHTML = '<p class="muted">단원이 없어요.</p>'; return; }
  API.call({ action: 'questions', topicId: t.id }).then(r => {
    if (!r.ok) { $('#tq-list').innerHTML = '<p class="muted">' + esc(r.message || '불러오지 못했어요') + '</p>'; return; }
    tAdmin.questions = r.questions.map(q => Object.assign({}, q)); tAdmin.source = r.source; renderTQList();
  }).catch(() => { $('#tq-list').innerHTML = '<p class="muted">연결 실패</p>'; });
}
/* 문항 파일·붙여넣기 해석 (CSV / 탭 / | 구분, JSON) */
function questionTemplateHref() {
  const rows = [['유형', '질문', '보기1', '보기2', '보기3', '보기4', '정답(번호 또는 단답 정답;정답)', '힌트'],
    ['객관식', '실험에서 의도적으로 변화시키는 변인은?', '통제 변인', '조작 변인', '종속 변인', '상수', '2', '내가 직접 조작하는 조건이에요'],
    ['단답형', '탐구 문제에 대한 잠정적인 답을 무엇이라고 하나요?', '', '', '', '', '가설;가설 설정', '"~일 것이다"라고 미리 세우는 답이에요']];
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  return 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);
}
async function readTextFile(f) {
  const buf = await f.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('euc-kr').decode(buf); }   // 엑셀 CSV(CP949)도 읽기
}
function splitCsvLine(line, d) {
  if (d !== ',') return line.split(d).map(x => x.trim());
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i];
    if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out.map(x => x.trim());
}
/* 시험지 형식: "1. 질문 / ① 보기 ② 보기 … / 정답: ② / 힌트: …" 블록들 */
function parseExamText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''));
  const circ = '①②③④⑤⑥';
  const qNum = l => { const m = l.match(/^\s*(?:문제\s*|문\s*)?(?:Q\s*)?(\d{1,2})\s*[.)]\s*\S/); return m ? Number(m[1]) : null; };
  const blocks = []; let cur = null, expected = 1, choiceNext = 1;   // 보기 번호(1) 2) 3) 4) 순서)와 문항 번호를 구분
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { if (cur && cur.length) { blocks.push(cur); cur = null; } continue; }
    const n = qNum(l);
    if (n !== null && cur && cur.length && n === choiceNext && n <= 6) {   // 1), 2), 3)… 이어지는 보기
      choiceNext += (l.match(/(?:^|\s)\(?[1-6]\s*[.)]\s/g) || []).length || 1; cur.push(l); continue;
    }
    if (n !== null && cur && cur.length && (n === expected || n === expected + 1)) { blocks.push(cur); cur = null; }
    if (n !== null && !cur) { expected = n + 1; choiceNext = 1; }
    (cur = cur || []).push(l);
  }
  if (cur && cur.length) blocks.push(cur);
  const out = [];
  for (const b of blocks) {
    let q = b[0].replace(/^\s*(?:문제\s*|문\s*)?(?:Q\s*)?\d{1,2}\s*[.)]\s*/, '').trim();
    const choices = []; let answer = null, hint = '';
    for (const l of b.slice(1)) {
      let m;
      if ((m = l.match(/^(?:정답|답|answer)\s*[:：]?\s*(.+)$/i))) { answer = m[1].trim(); continue; }
      if ((m = l.match(/^(?:힌트|해설|풀이|hint)\s*[:：]?\s*(.+)$/i))) { hint = m[1].trim(); continue; }
      if (/[①②③④⑤⑥]/.test(l)) { l.split(/(?=[①②③④⑤⑥])/).map(x => x.replace(/^[①②③④⑤⑥]\s*/, '').trim()).filter(Boolean).forEach(x => choices.push(x)); continue; }
      if (/^\(?[1-6a-fA-F가-바ㄱ-ㅂ]\s*[.)]\s*\S/.test(l)) { l.split(/\s+(?=\(?[1-6a-fA-F가-바ㄱ-ㅂ]\s*[.)]\s)/).map(x => x.replace(/^\(?[1-6a-fA-F가-바ㄱ-ㅂ]\s*[.)]\s*/, '').trim()).filter(Boolean).forEach(x => choices.push(x)); continue; }
      if (!choices.length && answer === null) q += ' ' + l;   // 질문이 여러 줄
    }
    q = q.trim(); if (!q) continue;
    if (choices.length >= 2) {
      const cs = choices.slice(0, 4); let a = -1; const ans = String(answer || '').trim();
      if (circ.includes(ans[0])) a = circ.indexOf(ans[0]); else if (/^[1-4]$/.test(ans)) a = Number(ans) - 1; else if (/^[a-dA-D]$/.test(ans)) a = ans.toLowerCase().charCodeAt(0) - 97; else if (/^[가나다라]$/.test(ans)) a = '가나다라'.indexOf(ans); else if (/^[ㄱㄴㄷㄹ]$/.test(ans)) a = 'ㄱㄴㄷㄹ'.indexOf(ans); else a = cs.findIndex(c => c.replace(/\s/g, '') === ans.replace(/\s/g, ''));
      if (a < 0 || a >= cs.length) continue;   // 정답을 못 찾은 객관식은 건너뜀
      out.push({ type: 'mc', q, choices: cs, answer: a, hint });
    } else if (answer) {
      out.push({ type: 'short', q, answers: answer.split(/[,;/、]/).map(x => x.trim()).filter(Boolean), hint });
    }
  }
  return out;
}
/* OCR 결과 다듬기: 흔한 오인식 교정 */
function tidyOcrText(t) {
  const circ = '①②③④⑤⑥';
  const marker = /(^|\s)(?:[@©®⊙◎○◯●Ⓐ-Ⓩⓐ-ⓩ]|[\(（]\s*[1-6]\s*[\)）]|[1-6]\s*[\)）.]|[1-6](?=\s+[가-힣A-Za-z]))\s*/g;   // OCR 이 ①②③④ 를 @, (2), 2) 등으로 읽은 것
  const lines = String(t || '').replace(/\r/g, '').split('\n').map(l => l.replace(/[|丨]/g, '').trim());
  const out = lines.map(l => {
    if (/^(정답|답)\s*[:：]/.test(l)) return l.replace(/^(정답|답)\s*[:：]?\s*[\(（]?\s*([1-6])\s*[\)）]?\s*$/, (m, a, n) => '정답: ' + circ[Number(n) - 1]);
    const cnt = (l.match(marker) || []).length;
    if (cnt >= 3 && !/^\d{1,2}\s*[.)]\s/.test(l)) { let k = 0; return l.replace(marker, (m, pre) => (k < 6 ? pre + circ[k++] + ' ' : m)).trim(); }
    return l;
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/* 그림 파일 → 글자 (Tesseract.js, 이 기기에서 처리. 라이브러리와 한글 인식 파일만 CDN에서 내려받음) */
let tessPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tessPromise) tessPromise = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('글자 인식 라이브러리를 내려받지 못했어요 (인터넷 확인)')); document.head.appendChild(s); });
  return tessPromise;
}
async function ocrImageFile(file, onProgress) {
  await loadTesseract();
  const dataUrl = await fileToJpeg(file, 1800, 2500000);
  const worker = await Tesseract.createWorker('kor+eng', 1, { logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(Math.round((m.progress || 0) * 100)); } });
  try { const r = await worker.recognize(dataUrl); return r.data.text || ''; } finally { worker.terminate(); }
}
/* 그림 파일 → 축소 JPEG data URL (긴 변 max px, 길이 maxChars 이하) */
function fileToJpeg(file, max, maxChars) {
  return new Promise((res, rej) => {
    if (!/^image\//.test(file.type)) return rej(new Error('이미지 파일(jpg, png)만 돼요'));
    const rd = new FileReader();
    rd.onerror = () => rej(new Error('파일을 읽지 못했어요'));
    rd.onload = () => { const im = new Image(); im.onerror = () => rej(new Error('그림을 열지 못했어요')); im.onload = () => {
      const r = Math.min(1, max / Math.max(im.width, im.height)); const cv = document.createElement('canvas'); cv.width = Math.round(im.width * r); cv.height = Math.round(im.height * r);
      const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); c.drawImage(im, 0, 0, cv.width, cv.height);
      let q = 0.85, out = cv.toDataURL('image/jpeg', q); while (out.length > maxChars && q > 0.3) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
      res(out); }; im.src = rd.result; };
    rd.readAsDataURL(file);
  });
}
/* 문항 그림 불러오기 (서버 'qimg', 메모리 캐시) */
const qimgCache = {};
function loadQuestionImages(root) {
  if (!root) return;
  Array.from(root.querySelectorAll('.qimg')).forEach(async box => {
    const fid = box.dataset.fid; const img = box.querySelector('img'); const note = box.querySelector('span');
    try {
      if (!qimgCache[fid]) { if (MODE !== 'server') throw new Error('local'); const r = await API.call({ action: 'qimg', fileId: fid }); if (!r.ok) throw new Error(r.message || 'x'); qimgCache[fid] = r.data; }
      img.src = qimgCache[fid]; img.style.display = ''; if (note) note.remove();
    } catch (e) { if (note) note.textContent = '그림을 불러오지 못했어요'; }
  });
}
function parseQuestionText(text) {
  text = String(text || '').replace(/^\uFEFF/, '').trim(); if (!text) return [];
  const out = [];
  const push = q => { if (q && q.q) out.push(q); };
  if (/^[\[{]/.test(text)) {
    let j; try { j = JSON.parse(text); } catch (e) { return []; }
    (Array.isArray(j) ? j : (j.questions || [])).forEach(q => {
      if (q.type === 'mc' || Array.isArray(q.choices)) { const choices = (q.choices || []).map(String).filter(Boolean); let a = Number(q.answer); if (!(a >= 0 && a < choices.length)) a = Math.max(0, choices.indexOf(String(q.answer))); push({ type: 'mc', q: String(q.q || q.question || ''), choices, answer: a, hint: String(q.hint || '') }); }
      else push({ type: 'short', q: String(q.q || q.question || ''), answers: [].concat(q.answers || q.answer || []).map(String).filter(Boolean), hint: String(q.hint || '') });
    });
    return out;
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const d = lines[0].includes('\t') ? '\t' : (lines[0].includes('|') ? '|' : ',');
  lines.forEach(line => {
    const c = splitCsvLine(line, d); if (c.length < 2) return;
    if (/유형|질문|^type$/i.test(c[0]) && /질문|question|q/i.test(c[1])) return;   // 머리글
    const t = c[0]; const q = c[1]; if (!q) return;
    const isMc = /객관|선택|^mc$|^m$|^1$/i.test(t) || (!/단답|주관|short|^s$|^2$/i.test(t) && c.slice(2, 6).filter(Boolean).length >= 2);
    if (isMc) {
      const choices = c.slice(2, 6).filter(Boolean); if (choices.length < 2) return;
      const ans = (c[6] || '').trim(); let a = -1;
      if (/^[1-4]$/.test(ans)) a = Number(ans) - 1; else if (/^[①②③④]$/.test(ans)) a = '①②③④'.indexOf(ans); else a = choices.indexOf(ans);
      if (a < 0 || a >= choices.length) a = 0;
      push({ type: 'mc', q, choices, answer: a, hint: c[7] || '' });
    } else {
      const raw = c[6] || c[2] || ''; const answers = raw.split(/[;；]/).map(x => x.trim()).filter(Boolean);
      push({ type: 'short', q, answers, hint: c[7] || c[3] || '' });
    }
  });
  if (!out.length || !lines.some(l => l.includes(d) && (d !== ',' || l.split(',').length >= 4))) { const ex = parseExamText(text); if (ex.length >= out.length) return ex; }
  return out;
}
function renderTQList() {
  const list = tAdmin.questions;
  $('#tq-list').innerHTML = `<p class="muted small">${tAdmin.source === 'sheet' ? '문항 시트에 저장된 문항이에요.' : '아직 문항 시트에 없어서 기본 문항을 보여 줘요. 저장하면 문항 시트에 들어가요.'} 저장 후 5분 안에 학생 화면에 반영돼요.</p>
    ${list.map((q, i) => `<div class="summary-card"><div class="meta"><span><b>Q${i + 1}</b> <select data-i="${i}" data-k="type"><option value="mc" ${q.type === 'mc' ? 'selected' : ''}>객관식</option><option value="short" ${q.type === 'short' ? 'selected' : ''}>단답형</option></select></span><button class="btn tiny danger tq-del" data-i="${i}">삭제</button></div>
      <label>질문 <input type="text" data-i="${i}" data-k="q" value="${esc(q.q)}" maxlength="200"></label>
      ${q.type === 'mc' ? `<div class="row-label">보기 (정답에 ● 표시)</div>${[0, 1, 2, 3].map(j => `<div style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="radio" name="ans${i}" value="${j}" ${q.answer === j ? 'checked' : ''}><input type="text" data-i="${i}" data-k="c${j}" value="${esc((q.choices || [])[j] || '')}" placeholder="보기 ${j + 1}" maxlength="60"></div>`).join('')}`
        : `<label>정답 (여러 개면 ; 로 구분) <input type="text" data-i="${i}" data-k="answers" value="${esc((q.answers || []).join(';'))}" maxlength="100"></label>`}
      <label>힌트 (틀렸을 때 보여 줄 발판) <input type="text" data-i="${i}" data-k="hint" value="${esc(q.hint || '')}" maxlength="120"></label>
      <div class="field-row" style="align-items:center"><span class="small"><b>🖼️ 그림</b></span>${q.imgData ? `<img src="${q.imgData}" alt="" style="height:56px;border-radius:8px">` : (q.img ? `<span class="qimg" data-fid="${esc(q.img)}"><img alt="" style="height:56px;border-radius:8px;display:none"><span class="muted small">불러오는 중...</span></span>` : '<span class="muted small">없음</span>')}<button class="btn tiny tq-img" data-i="${i}">${q.img || q.imgData ? '바꾸기' : '그림 넣기'}</button>${q.img || q.imgData ? `<button class="btn tiny danger tq-img-del" data-i="${i}">그림 삭제</button>` : ''}</div></div>`).join('')}
    <input type="file" id="tq-imgfile" accept="image/*" class="hidden">
    ${list.length ? '' : '<p class="muted small">문항이 없어요. 추가해 보세요.</p>'}
    <div class="btn-row"><button class="btn" id="tq-add-mc">+ 객관식 추가</button><button class="btn" id="tq-add-short">+ 단답형 추가</button><button class="btn primary" id="tq-save">문항 저장</button></div>
    <div class="row-label" style="margin-top:12px">문항 한꺼번에 추가 <small class="muted">— 추가된 초안은 위 목록에서 고친 뒤 "문항 저장"을 눌러야 저장돼요 · 성취기준당 10개까지</small></div>
    <div class="btn-row"><button class="btn" id="tq-gen">✨ 자동 생성 <select id="tq-gen-n" style="padding:2px 4px"><option value="3">3개</option><option value="5" selected>5개</option><option value="8">8개</option></select></button><button class="btn" id="tq-file-btn">📄 파일로 추가</button><input type="file" id="tq-file" accept=".csv,.txt,.tsv,.json,image/*" class="hidden"><button class="btn" id="tq-paste-btn">📋 붙여넣기로 추가</button><a class="btn" id="tq-template" download="문항서식.csv" href="${questionTemplateHref()}">⬇ 서식 파일</a></div>
    <p class="muted small">자동 생성은 이 성취기준의 핵심 개념과 본문 문장으로 빈칸·단답 문항 초안을 만들어요(외부 AI를 쓰지 않고, 이미 목록에 있는 문항은 다시 만들지 않아요). <b>파일로 추가</b>는 CSV·탭·JSON 문항 파일 또는 <b>시험지 사진·그림</b>(jpg, png)을 받아요. 그림은 이 기기에서 글자를 읽어(OCR) 붙여넣기 칸에 넣어 주니 확인 후 추가하면 돼요.</p>
    <div id="tq-paste" class="hidden"><div class="notice small"><b>붙여넣기 사용법</b> — 한글 문서·시험지에서 복사한 글을 그대로 붙여 넣으면 돼요. 문항마다 <b>번호. 질문</b> → <b>① ② ③ ④ 보기</b>(또는 1) 2) 3) 4), 한 줄에 여러 개 가능) → <b>정답: ②</b> → <b>힌트: ...</b>(선택) 순서로 쓰고, 보기가 없으면 <b>정답: 가설, 가설 설정</b>처럼 쓰면 단답형이 돼요. 문항 사이는 빈 줄로 띄워요. 표 형식(CSV·탭)도 돼요. <button class="link" id="tq-example">예시 넣어 보기</button></div>
      <textarea id="tq-paste-text" rows="8" placeholder="1. 실험에서 의도적으로 변화시키는 변인은?&#10;① 통제 변인 ② 조작 변인 ③ 종속 변인 ④ 상수&#10;정답: ②&#10;힌트: 내가 직접 조작하는 조건이에요&#10;&#10;2. 탐구 문제에 대한 잠정적인 답을 무엇이라고 하나요?&#10;정답: 가설, 가설 설정"></textarea><div class="btn-row"><button class="btn primary" id="tq-paste-add">목록에 추가</button></div></div>`;
  const addMany = (qs, label) => {
    sync();
    const room = Math.max(0, 10 - list.length);
    if (!qs.length) return toast('추가할 문항을 찾지 못했어요. 형식을 확인해 주세요', 'bad');
    if (!room) return toast('문항은 성취기준당 10개까지예요. 먼저 몇 개를 삭제해 주세요', 'bad');
    const add = qs.slice(0, room); list.push(...add); renderTQList();
    toast(`${label} 문항 ${add.length}개를 목록에 추가했어요. 확인·수정 후 "문항 저장"을 누르세요${qs.length > add.length ? ` (10개 제한으로 ${qs.length - add.length}개는 뺐어요)` : ''}`, 'ok');
  };
  $('#tq-gen').onclick = async () => {
    sync();
    const r = await API.call({ action: 'genQuestions', topicId: tAdmin.topicId, count: Number($('#tq-gen-n').value), exclude: list.map(q => q.q) }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) addMany(r.questions, '자동 생성'); else toast(r.message || '자동 생성에 실패했어요', 'bad');
  };
  $('#tq-file-btn').onclick = () => $('#tq-file').click();
  $('#tq-file').onchange = async () => {
    const f = $('#tq-file').files[0]; if (!f) return;
    if (/^image\//.test(f.type)) {
      $('#tq-paste').classList.remove('hidden');
      const ta = $('#tq-paste-text'); ta.value = ''; ta.placeholder = '그림에서 글자를 읽는 중이에요... (처음에는 한글 인식 파일을 내려받느라 20~40초 걸릴 수 있어요)';
      try { const text = await ocrImageFile(f, p => { ta.placeholder = '글자 읽는 중... ' + p + '%'; });
        ta.value = tidyOcrText(text); ta.placeholder = '';
        const got = parseQuestionText(ta.value).length;
        toast(got ? `글자를 읽어 문항 ${got}개를 찾았어요. 아래 내용을 확인·수정한 뒤 "목록에 추가"를 누르세요` : '글자는 읽었지만 문항 형식을 찾지 못했어요. 아래 글을 시험지 형식으로 고친 뒤 "목록에 추가"를 누르세요', got ? 'ok' : 'bad');
        ta.scrollIntoView({ block: 'center' });
      } catch (e) { ta.placeholder = ''; toast('그림에서 글자를 읽지 못했어요: ' + e.message, 'bad'); }
      $('#tq-file').value = ''; return;
    }
    try { const text = await readTextFile(f); addMany(parseQuestionText(text), '파일'); } catch (e) { toast('파일을 읽지 못했어요: ' + e.message, 'bad'); }
    $('#tq-file').value = '';
  };
  $('#tq-paste-btn').onclick = () => $('#tq-paste').classList.toggle('hidden');
  $('#tq-example').onclick = () => { $('#tq-paste-text').value = '1. 실험에서 의도적으로 변화시키는 변인은?\n① 통제 변인 ② 조작 변인 ③ 종속 변인 ④ 상수\n정답: ②\n힌트: 내가 직접 조작하는 조건이에요\n\n2. 탐구 문제에 대한 잠정적인 답을 무엇이라고 하나요?\n정답: 가설, 가설 설정\n힌트: "~일 것이다"라고 미리 세우는 답이에요'; };
  $('#tq-paste-add').onclick = () => addMany(parseQuestionText($('#tq-paste-text').value), '붙여넣기');
  const sync = () => {
    $$('#tq-list input[data-i], #tq-list select[data-i]').forEach(el => {
      const q = list[+el.dataset.i], k = el.dataset.k; if (!q) return;
      if (k === 'q' || k === 'hint') q[k] = el.value;
      else if (k === 'answers') q.answers = el.value.split(';').map(x => x.trim()).filter(Boolean);
      else if (/^c\d$/.test(k)) { q.choices = q.choices || ['', '', '', '']; q.choices[+k[1]] = el.value; }
    });
    list.forEach((q, i) => { if (q.type === 'mc') { const r = document.querySelector(`input[name=ans${i}]:checked`); q.answer = r ? +r.value : (q.answer || 0); } });
  };
  $$('#tq-list select[data-k=type]').forEach(s => s.onchange = () => { sync(); const q = list[+s.dataset.i]; q.type = s.value; if (q.type === 'mc') { q.choices = q.choices || ['', '', '', '']; q.answer = q.answer || 0; } else q.answers = q.answers || []; renderTQList(); });
  $$('.tq-del').forEach(b => b.onclick = () => { sync(); list.splice(+b.dataset.i, 1); renderTQList(); });
  $$('.tq-img').forEach(b => b.onclick = () => { sync(); const fi = $('#tq-imgfile'); fi.dataset.i = b.dataset.i; fi.value = ''; fi.click(); });
  $$('.tq-img-del').forEach(b => b.onclick = () => { sync(); const q = list[+b.dataset.i]; q.img = ''; q.imgData = ''; renderTQList(); });
  $('#tq-imgfile').onchange = async () => {
    const fi = $('#tq-imgfile'); const f = fi.files[0]; const q = list[+fi.dataset.i]; if (!f || !q) return;
    try { q.imgData = await fileToJpeg(f, 900, 300000); q.img = ''; renderTQList(); toast('그림을 넣었어요. "문항 저장"을 눌러야 저장돼요'); } catch (e) { toast('그림을 읽지 못했어요: ' + e.message, 'bad'); }
  };
  loadQuestionImages($('#tq-list'));
  $('#tq-add-mc').onclick = () => { sync(); list.push({ type: 'mc', q: '', choices: ['', '', '', ''], answer: 0, hint: '' }); renderTQList(); };
  $('#tq-add-short').onclick = () => { sync(); list.push({ type: 'short', q: '', answers: [], hint: '' }); renderTQList(); };
  $('#tq-save').onclick = async () => {
    sync();
    const payload = [];
    for (const q of list) {
      if (q.type === 'mc') {
        const kept = (q.choices || []).map((c, j) => ({ c: String(c || '').trim(), j })).filter(x => x.c);
        const answer = kept.findIndex(x => x.j === q.answer);
        if (q.q.trim() && answer < 0) return toast(`"${q.q.slice(0, 15)}…" 문항의 정답 보기가 비어 있어요`, 'bad');
        payload.push({ type: 'mc', q: q.q, choices: kept.map(x => x.c), answer, hint: q.hint, img: q.img || '', imgData: q.imgData || '' });
      } else payload.push({ type: 'short', q: q.q, answers: q.answers || [], hint: q.hint, img: q.img || '', imgData: q.imgData || '' });
    }
    const r = await API.call({ action: 'saveQuestions', topicId: tAdmin.topicId, questions: payload }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) { toast(`문항 ${r.count}개를 저장했어요`, 'ok'); tAdmin.source = 'sheet'; if (Array.isArray(r.questions)) { tAdmin.questions = r.questions.map(q => Object.assign({}, q)); renderTQList(); } const t = topicOf(tAdmin.topicId); if (t) t.questions = (Array.isArray(r.questions) ? r.questions : payload.filter(q => q.q.trim())).map(q => ({ type: q.type, q: q.q, choices: q.choices, img: q.img || '' })); if (study.step === 'quiz' && study.topic && study.topic.id === tAdmin.topicId) { study.answers = {}; study.graded = false; renderStudy(); } }
    else toast(r.message || '저장에 실패했어요', 'bad');
  };
}

/* ---------------- 교사 모드 추가 기능: 접속 중 학생 · 학생 방 학습 상황 · 전체 학생 서재 ---------------- */
const STUDENT_EMOJIS = ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐤', '🦄', '🐙', '🐢', '🦋', '🐬', '🦉'];
function emojiFor(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return STUDENT_EMOJIS[h % STUDENT_EMOJIS.length]; }
let onlineList = [];
let unitStats = { stats: {}, at: 0 };   // 교사: 단원별 활동 시작 학생 수(누적)
async function pollUnitStats(force) {
  if (!isTeacher() || (!force && Date.now() - unitStats.at < 300000)) return;
  try { const r = await API.call({ action: 'unitStats' }); if (r.ok) { unitStats = { stats: r.stats || {}, at: Date.now() }; if ($('#screen-room').classList.contains('active')) renderRoom(); } } catch (e) { /* ignore */ }
}
function renderOnlineCard() {
  if (!isTeacher()) return;
  let card = $('#online-card');
  if (!card) { card = document.createElement('div'); card.id = 'online-card'; card.className = 'card'; card.style.background = '#ecfdf5'; $('#room-panel').insertBefore(card, $('#room-panel').firstChild); }
  const here = onlineList.filter(st => st.where === tUnit), other = onlineList.filter(st => st.where !== tUnit);
  const chip = st => `<span class="chip online-chip" data-id="${esc(st.id)}" style="font-size:1rem;cursor:pointer" title="방 방문">${emojiFor(st.id)} ${esc(st.name)} <small class="muted">${esc(st.id)}</small></span>`;
  card.innerHTML = `<h3>🟢 ${esc(tUnit ? unitTitle(tUnit) : '단원')}에서 활동 중 <small class="muted">${here.length}명 · 최근 5분</small></h3>` +
    (here.length ? `<div class="chips">${here.map(chip).join('')}</div>` : '<p class="muted small">이 단원에서 활동 중인 학생이 없어요.</p>') +
    `<div class="row-label" style="margin-top:10px">다른 단원·방 <small class="muted">${other.length}명</small></div>` +
    (other.length ? `<div class="chips">${other.map(st => `<span class="chip online-chip" data-id="${esc(st.id)}" style="cursor:pointer">${emojiFor(st.id)} ${esc(st.name)} <small class="muted">${esc(st.where === 'home' ? '방 꾸미기' : (unitOf(st.where) ? unitTitle(st.where) : '접속 중'))}</small></span>`).join('')}</div>` : '<p class="muted small">없음</p>') +
    `<p class="muted small" style="margin-top:8px">전체 접속 ${onlineList.length}명 · 1분마다 새로 확인해요. 이름을 누르면 그 학생 방에 들어가요.</p>`;
  $$('#online-card .online-chip').forEach(el => el.onclick = () => { showScreen('friends'); visitFriend(el.dataset.id); });
}
async function pollOnline() {
  try { const r = await API.call({ action: 'online' }); if (r.ok) { onlineList = r.students || []; if ($('#screen-room').classList.contains('active')) renderRoom(); }
    pollUnitStats(false); } catch (e) { /* ignore */ }
}
function teacherVisitCard(v) {
  const recs = (v.records || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const monsters = (v.monsterRooms || []).map(unitTitle);
  return `<div class="card" style="background:#eef6ff"><h3>📊 학습 상황 <small class="muted">— 교사에게만 보여요</small></h3>
    <p class="small">🪙 코인 ${v.coins ?? '-'} · 기록 ${recs.length}건 · 통과 ${recs.filter(r => r.pass).length}건${monsters.length ? ` · 👾 먼지 괴물: ${esc(monsters.join(', '))}` : ' · 먼지 괴물 없음'}</p>
    ${recs.length ? `<div class="sheet-wrap"><table class="sheet"><thead><tr><th>날짜</th><th>성취기준</th><th>결과</th><th>점수</th><th>개념</th><th>퀴즈</th><th>시도</th><th>요약</th></tr></thead><tbody>
      ${recs.slice(0, 60).map(r => `<tr><td>${shortDate(r.date)}</td><td>${esc(topicCode(r.topicId) || unitTitle(r.unitId))}</td><td>${r.pass ? '✅ 통과' : '❌ 재도전'}</td><td>${r.score}</td><td>${(r.opened || []).length}</td><td>${r.quiz ? r.quiz.correct + '/' + r.quiz.total : '-'}</td><td>${r.attempts}</td><td class="small">${esc(r.summary)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted small">아직 학습 기록이 없어요.</p>'}</div>`;
}
let tLib = { filter: '', rows: null };
async function renderTeacherLibrary() {
  const body = $('#library-body');
  if (!tLib.rows) {
    body.innerHTML = '<div class="card"><h2>📚 전체 학생 학습 정리</h2><p class="muted">불러오는 중...</p></div>';
    try { const r = await API.call({ action: 'allSummaries' }); if (!r.ok) throw new Error(r.message || r.error); tLib.rows = r.rows || []; }
    catch (e) { body.innerHTML = '<div class="card"><h2>📚 전체 학생 학습 정리</h2><p class="muted">불러오지 못했어요: ' + esc(e.message) + '</p></div>'; return; }
  }
  const rows = tLib.rows.filter(r => !tLib.filter || r.unitId === tLib.filter);
  body.innerHTML = `<div class="card"><h2>📚 전체 학생 학습 정리 <small class="muted">${tLib.rows.length}건</small></h2>
    <p class="muted small">학생들이 제출한 요약 전체예요(통과·재도전 모두). 점수와 열린 개념 수는 교사에게만 보여요.</p>
    <div class="btn-row"><select id="tl-unit"><option value="">모든 단원</option>${units.map(u => `<option value="${esc(u.id)}" ${tLib.filter === u.id ? 'selected' : ''}>${esc(u.subject)} · ${esc(u.title)}</option>`).join('')}</select><button class="btn" id="tl-refresh">새로 고침</button></div></div>
    <div class="card">${rows.length ? rows.map(r => `<div class="rec"><div class="meta"><b>${emojiFor(r.id)} ${esc(r.name)} <small>${esc(r.id)}</small></b><span>${shortDate(r.date)}</span><span>${esc(unitTitle(r.unitId))}${topicCode(r.topicId) ? ' · ' + esc(topicCode(r.topicId)) : ''}</span>
      <span class="tag ${r.pass ? 'pass' : 'fail'}">${r.pass ? '통과' : '재도전'}</span><span>${r.score}점</span><span>개념 ${r.opened}개</span><span>퀴즈 ${r.quiz || '-'}</span><span>${r.attempts}회</span></div><div class="text">${esc(r.summary)}</div></div>`).join('') : '<p class="muted">기록이 없어요.</p>'}</div>`;
  $('#tl-unit').onchange = e => { tLib.filter = e.target.value; renderTeacherLibrary(); };
  $('#tl-refresh').onclick = () => { tLib.rows = null; renderTeacherLibrary(); };
}

/* ---------------- 관리자: 교사 등록·승인 ---------------- */
async function loadTTeachers() {
  const box = $('#t-teachers'); if (!box) return;
  const r = await API.call({ action: 'teachers' }).catch(() => ({ ok: false, message: '연결 실패' }));
  if (!r.ok) { box.innerHTML = '<h3>👩‍🏫 교사 등록·승인</h3><p class="muted small">' + esc(r.message || '불러오지 못했어요') + '</p>'; return; }
  tAdmin.owner = r.owner; tAdmin.teachers = r.teachers.map(t => Object.assign({ initPassword: '' }, t)); renderTTeachers();
}
function renderTTeachers() {
  const box = $('#t-teachers'); if (!box) return;
  const list = tAdmin.teachers;
  box.innerHTML = `<h3>👩‍🏫 교사 등록·승인 <small class="muted">— 관리자(시트 소유자)에게만 보여요</small></h3>
    <p class="muted small">이메일과 이름을 넣고 <b>승인</b>을 켜면 그 선생님이 교사로 들어올 수 있어요. <b>비밀번호</b> 칸에는 지금 비밀번호가 보이고, 새로 입력하면 바뀌어요. 비밀번호를 정해 주면 접속 코드 없이 이메일+비밀번호로 바로 들어오고, 비워 두면 선생님이 접속 코드로 처음 등록해요. 승인하면 학교 폴더도 함께 공유돼요.</p>
    <div class="notice small">⚠️ 교사 비밀번호는 관리자가 확인할 수 있어요. 은행·포털 등 다른 곳에서 쓰는 중요한 비밀번호는 쓰지 말고, 이 앱 전용 비밀번호를 정해 주세요. 선생님들께도 이 점을 알려 주세요.</div>
    <div class="sheet-wrap"><table class="sheet"><thead><tr><th>이메일</th><th>이름</th><th>승인</th><th>비밀번호 <small class="muted">(현재 · 새로 정하기)</small></th><th></th></tr></thead><tbody>
    ${list.map((t, i) => { const own = t.email === tAdmin.owner; return `<tr><td><input type="text" data-i="${i}" data-k="email" value="${esc(t.email)}" maxlength="80" placeholder="teacher@school.kr" ${own ? 'disabled' : ''}></td>
      <td><input type="text" data-i="${i}" data-k="name" value="${esc(t.name)}" maxlength="20" placeholder="이름"></td>
      <td style="text-align:center"><input type="checkbox" data-i="${i}" data-k="approved" ${t.approved ? 'checked' : ''} ${own ? 'disabled' : ''}>${own ? ' <small class="muted">관리자</small>' : ''}</td>
      <td><div class="small" style="margin-bottom:4px">현재: <code>${esc(t.password || (t.hasPw ? '(확인 불가 · 새로 정해 주세요)' : '없음'))}</code></div><input type="text" data-i="${i}" data-k="initPassword" value="${esc(t.initPassword || '')}" maxlength="40" autocomplete="off" placeholder="새 비밀번호 (6자 이상)"></td>
      <td>${own ? '' : `<button class="btn tiny danger tt-del" data-i="${i}">삭제</button>`}</td></tr>`; }).join('')}
    </tbody></table></div>
    ${list.length ? '' : '<p class="muted small">등록된 교사가 없어요.</p>'}
    <div class="btn-row"><button class="btn" id="tt-add">+ 교사 추가</button><button class="btn primary" id="tt-save">교사 저장</button></div>`;
  const sync = () => $$('#t-teachers [data-k]').forEach(el => { const t = list[+el.dataset.i]; if (!t) return; const k = el.dataset.k; if (k === 'approved') t.approved = el.checked; else t[k] = el.value; });
  $$('.tt-del').forEach(b => b.onclick = () => { sync(); const t = list[+b.dataset.i]; if (!confirm((t.email || '이 교사') + ' 을(를) 교사 목록에서 지울까요? 그 선생님은 더 이상 교사로 들어올 수 없어요.')) return; list.splice(+b.dataset.i, 1); renderTTeachers(); });
  $('#tt-add').onclick = () => { sync(); list.push({ email: '', name: '', approved: true, initPassword: '', hasPw: false }); renderTTeachers(); };
  $('#tt-save').onclick = async () => {
    sync();
    const teachers = list.filter(t => (t.email || '').trim()).map(t => ({ email: t.email.trim().toLowerCase(), name: t.name, approved: !!t.approved, initPassword: t.initPassword || '' }));
    const r = await API.call({ action: 'saveTeachers', teachers }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) { tAdmin.teachers = r.teachers.map(t => Object.assign({ initPassword: '' }, t)); toast(`교사 ${r.teachers.length}명을 저장했어요`, 'ok'); renderTTeachers(); }
    else toast(r.message || '저장에 실패했어요', 'bad');
  };
}
/* ---------------- 교사: 비밀번호 설정 ---------------- */
document.addEventListener('click', async e => {
  if (!e.target || e.target.id !== 't-pw-save') return;
  const a = $('#t-pw1').value, b = $('#t-pw2').value;
  if (a.length < 6) return toast('비밀번호는 6자 이상이에요', 'bad');
  if (a !== b) return toast('두 비밀번호가 달라요', 'bad');
  const r = await API.call({ action: 'teacherSetPassword', password: a }).catch(() => ({ ok: false, message: '연결 실패' }));
  if (r.ok) { $('#t-pw1').value = ''; $('#t-pw2').value = ''; toast('교사 비밀번호를 저장했어요. 다음부터 이메일로 들어오세요', 'ok'); } else toast(r.message || '저장에 실패했어요', 'bad');
});
/* ---------------- 교사: 가격 설정 (상점) ---------------- */
function renderTPrices() {
  const box = $('#t-prices'); if (!box) return;
  const p = (serverSettings && serverSettings.prices) || {};
  const fields = [['common', '일반 가구 기본가'], ['rare', '레어 가구 기본가'], ['epic', '에픽 가구 기본가'], ['recolor', '색상 리폼'], ['restyle', '스타일 리폼'], ['wallpaper', '벽지·바닥'], ['photoFrame', '사진 액자']];
  box.innerHTML = `<h3>💰 가격 설정 <small class="muted">— 교사에게만 보여요 · 모든 학생에게 적용</small></h3>
    <div class="chips">${fields.map(([k, n]) => `<label class="small" style="display:flex;align-items:center;gap:4px;margin:0">${n} <input type="number" min="0" data-tprice="${k}" value="${p[k] ?? ''}" style="width:80px;padding:6px 8px"></label>`).join('')}</div>
    <div class="btn-row"><button class="btn primary" id="tp-save">가격 저장</button><span class="muted small">가구 하나하나의 가격은 아래 가구 상점 카드에서 따로 정할 수 있어요.</span></div>`;
  $('#tp-save').onclick = async () => {
    const prices = {}; $$('#t-prices input[data-tprice]').forEach(i => { if (i.value !== '') prices[i.dataset.tprice] = Number(i.value); });
    const r = await API.call({ action: 'saveSettings', settings: { prices } }).catch(() => ({ ok: false, message: '연결 실패' }));
    if (r.ok) { serverSettings = Object.assign({}, serverSettings, { prices: r.settings.prices }); applyPricing(r.settings.prices); toast('가격을 저장했어요', 'ok'); renderShop(); } else toast(r.message || '실패했어요', 'bad');
  };
}
/* ---------------- 교사: 가구 추가 (상점) ---------------- */
function renderTItems() {
  const box = $('#t-items'); if (!box) return;
  const list = tAdmin.items || [];
  const shapes = Object.keys(ITEMS).filter(k => !ITEMS[k].custom && k !== 'photo_frame' && k !== 'concept_frame');
  box.innerHTML = `<h3>🪑 가구 추가 <small class="muted">— 교사에게만 보여요 · 기존 가구 모양을 빌려 새 가구를 만들어요</small></h3>
    <p class="muted small">이름·이모지·희귀도·가격을 정하고 모양을 고르세요. "상점 판매"를 끄면 상점에서 사라지고, "상자 드롭"을 켜면 요약 통과 가구 상자에서도 나와요. 삭제해도 이미 가진 학생의 방에서는 없어지지 않아요.</p>
    ${list.map((x, i) => `<div class="summary-card"><div class="meta"><span><b>${esc(x.emoji || '')} ${esc(x.name || '(이름 없음)')}</b> <small class="muted">${esc(x.id)}</small></span><button class="btn tiny danger ti-del" data-i="${i}">삭제</button></div>
      <div class="field-row">
        <label style="flex:2 1 140px">이름 <input type="text" data-i="${i}" data-k="name" value="${esc(x.name)}" maxlength="20" placeholder="예: 황금 의자"></label>
        <label style="flex:0 0 84px">이모지 <input type="text" data-i="${i}" data-k="emoji" value="${esc(x.emoji)}" maxlength="4" placeholder="🪑"></label>
        <label style="flex:2 1 160px">모양 <select data-i="${i}" data-k="shape">${shapes.map(k => `<option value="${k}" ${x.shape === k ? 'selected' : ''}>${ITEMS[k].emoji} ${esc(ITEMS[k].name)}${ITEMS[k].wall ? ' (벽)' : ''}</option>`).join('')}</select></label>
        <label style="flex:0 0 110px">희귀도 <select data-i="${i}" data-k="rarity">${Object.keys(RARITY).map(k => `<option value="${k}" ${x.rarity === k ? 'selected' : ''}>${RARITY[k].name}</option>`).join('')}</select></label>
        <label style="flex:0 0 110px">가격 (코인) <input type="number" min="0" data-i="${i}" data-k="cost" value="${x.cost || ''}" placeholder="기본가"></label>
        <label class="toggle"><input type="checkbox" data-i="${i}" data-k="sell" ${x.sell !== false ? 'checked' : ''}> 상점 판매</label>
        <label class="toggle"><input type="checkbox" data-i="${i}" data-k="box" ${x.pool === 'box' ? 'checked' : ''}> 상자 드롭</label>
      </div></div>`).join('')}
    ${list.length ? '' : '<p class="muted small">아직 추가한 가구가 없어요.</p>'}
    <div class="btn-row"><button class="btn" id="ti-add">+ 가구 추가</button><button class="btn primary" id="ti-save">가구 저장</button></div>`;
  const sync = () => $$('#t-items [data-k]').forEach(el => { const x = list[+el.dataset.i]; if (!x) return; const k = el.dataset.k;
    if (k === 'sell') x.sell = el.checked; else if (k === 'box') x.pool = el.checked ? 'box' : 'shop'; else if (k === 'cost') x.cost = Number(el.value) || 0; else x[k] = el.value; });
  $$('.ti-del').forEach(b => b.onclick = () => { sync(); list.splice(+b.dataset.i, 1); renderTItems(); });
  $('#ti-add').onclick = () => { sync(); list.push({ id: 'ci' + Date.now().toString(36), name: '', emoji: '🎁', shape: 'plant', rarity: 'common', cost: 0, pool: 'shop', sell: true, enabled: true }); renderTItems(); };
  $('#ti-save').onclick = async () => {
    sync();
    const r = await API.call({ action: 'saveItems', items: list }).catch(e => ({ ok: false, message: '연결 실패: ' + e.message }));
    if (r.ok) { applyItems(r.items); tAdmin.items = customItems.map(x => Object.assign({}, x)); toast(`가구 ${customItems.length}개를 저장했어요. 상점에 바로 반영돼요`, 'ok'); renderShop(); }
    else toast('저장 실패: ' + (r.message || r.error || '알 수 없는 오류'), 'bad');
  };
}
/* ---------------- 벽 보기 (내 방) ---------------- */
function renderRoomHint() {
  const el = $('#room-hint'); if (!el) return;
  const v = myRoom.getView();
  if (v.mode === 'wall') {
    el.innerHTML = `<span class="small">${v.wall === 'R' ? '오른쪽 벽' : '왼쪽 벽'}을 보고 있어요. 액자·포스터·시계를 좌우로 끌어 옮길 수 있어요.</span>
      <div class="btn-row" style="justify-content:center;margin-top:6px"><button class="btn" id="btn-other-wall">🔄 다른 벽 보기</button><button class="btn primary" id="btn-iso">↩ 방 전체 보기</button></div>`;
    $('#btn-other-wall').onclick = () => { myRoom.toggleWall(); renderRoomHint(); };
    $('#btn-iso').onclick = () => { myRoom.setView('iso'); renderRoomHint(); };
  } else if (isTeacher()) {
    el.textContent = '위 단원 칩의 👥는 지금 그 단원을 학습 중인 학생 수, 시작 n명은 한 번이라도 학습한 학생 수예요. 칩을 누르면 아래에 이름이 보이고, 이름을 누르면 학생 방으로 들어가요.';
  } else {
    el.innerHTML = '가구를 끌어서 옮기고, 선택한 뒤 <b>R</b> 키로 회전할 수 있어요. <b>벽을 클릭</b>하면 그 벽을 크게 볼 수 있어요.';
  }
}
/* ---------------- 시작 ---------------- */
function start() {
  currentRoomId = Engine.HOME;
  document.body.classList.toggle('teacher', isTeacher());
  updateHeader(); checkLocks();
  $('#logout-btn').classList.toggle('hidden', MODE !== 'server');
  $('#tab-friends').classList.toggle('hidden', MODE !== 'server');
  if (MODE === 'server') { API.flush(); pollInbox(); clearInterval(pollTimer); pollTimer = setInterval(pollInbox, 60000); }
  showScreen(state.records.length ? 'room' : 'study');
}
async function init() {
  myRoom = createRoom($('#room-canvas'), () => state ? currentRoom() : { wall: '#f6ecdc', floor: '#d8b07c', inventory: [], monster: null }, {
    onSelect: () => state && renderRoomPanel(),
    onChange: () => afterRoomChange(),
    onInvalid: () => toast('거기에는 놓을 수 없어요', 'bad'),
    isLocked: () => isClassLocked(),
    onLockedTouch: () => toast('수업 시간에는 인테리어가 잠겨 있어요', 'bad'),
    readOnly: () => !state,
    onWallClick: side => { myRoom.setView('wall', side); renderRoomHint(); },
  });
  $$('.tab').forEach(b => b.onclick = () => state && showScreen(b.dataset.screen));
  $('#logout-btn').onclick = () => { if (confirm('나갈까요? 다시 들어오려면 학번과 비밀번호가 필요해요.')) logout(); };
  $('#privacy-select').onchange = async e => { const r = await dispatch({ type: 'settings', privacy: e.target.value }); if (r.ok) toast('방 공개 설정을 저장했어요'); };
  document.addEventListener('keydown', e => {
    if (!state || !$('#screen-room').classList.contains('active') || e.target.matches('input,textarea')) return;
    const sel = currentRoom().inventory.find(i => i.uid === myRoom.getSelected()); if (!sel) return;
    if (e.key === 'r' || e.key === 'R') { if (myRoom.rotate(sel)) afterRoomChange(); else toast('그 방향으로는 공간이 부족해요', 'bad'); }
    if (e.key === 'Delete' || e.key === 'Backspace') { myRoom.unplace(sel); afterRoomChange(); }
  });
  setInterval(checkLocks, 30000);

  if (MODE === 'local') {
    setTopics(typeof UNITS !== 'undefined' ? UNITS : []);
    try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (s && s.student) state = Engine.migrate(s, units); } catch (e) { state = null; }
    if (state) { saveLocal(); start(); } else renderLogin();
    return;
  }
  syncServerTime();
  const sess = API.loadSession();
  if (!sess || !sess.token) return renderLogin();
  $('#login-body').innerHTML = '<p class="center">불러오는 중...</p>'; $('#overlay-login').classList.remove('hidden');
  try {
    const r = await API.call({ action: 'load' });
    if (!r.ok) { if (r.error === 'night_lock') { $('#overlay-login').classList.add('hidden'); return $('#overlay-lock').classList.remove('hidden'); } API.clearSession(); return renderLogin('login', r.message || '다시 로그인해 주세요'); }
    setTopics(r.units); if (r.coupons) coupons = r.coupons; if (r.events) events = r.events; if (r.settings) { serverSettings = r.settings; applyPricing(r.settings.prices); applyItemPrices(r.settings.itemPrices); } if (r.items) applyItems(r.items); state = Engine.migrate(r.state, units); inbox = r.inbox || inbox;
    $('#overlay-login').classList.add('hidden'); start();
  } catch (e) { renderLogin('login', '서버에 연결할 수 없어요. 인터넷을 확인한 뒤 다시 들어와 주세요.'); }
}
document.addEventListener('DOMContentLoaded', init);
