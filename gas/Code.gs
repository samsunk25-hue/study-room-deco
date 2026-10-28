/* =====================================================================
 *  Code.gs — 스터디룸 서버 (Google Apps Script)
 *
 *  ■ 설치
 *   1. 교사가 지정한 구글 드라이브 폴더 안에 새 스프레드시트 "스터디룸 DB" 를 만든다.
 *   2. 시트 메뉴 확장 프로그램 → Apps Script 를 열고(컨테이너 바인딩) 파일을 추가한다.
 *        Code.gs      ← 이 파일
 *        catalog.gs   ← js/catalog.js 내용 그대로
 *        judge.gs     ← js/judge.js 내용 그대로
 *        engine.gs    ← js/engine.js 내용 그대로
 *        units.gs     ← js/units.js (선택: 메뉴 "예시 단원 채우기"용)
 *   3. 시트를 새로고침 → 메뉴 "🏠 스터디룸 → ① 초기 설치" (관리자 = 시트 소유자)
 *   4. 배포 → 새 배포 → 웹 앱 / 실행 계정: 나 / 액세스: 모든 사용자 → URL 을 js/catalog.js CONFIG.gasUrl 에 입력
 *
 *  ■ 저장 위치 (모두 이 스프레드시트가 있는 폴더 안)
 *   학생계정 시트  : 학번 | 이름 | 비밀번호해시 | 솔트 | 파일ID | 가입일 | 최근접속 | 공개설정 | 초기화 (학번 오름차순)
 *   학생데이터/    : <학번>.json  (방·가구·코인·요약 기록 — 학생별 1파일, 전역 잠금 없이 저장)
 *   승인대기사진/  : 교사 확인용 사진 (승인 처리 후 삭제)
 *   평가기록부 시트: 행=학번, 열=날짜 (10분마다 자동 갱신)
 *   승인요청 / 소셜 / 교사 / 단원 시트
 *
 *  ■ 원칙: 학생 데이터는 이 폴더 밖으로 나가지 않는다. (외부 AI 호출 없음 — 판정은 judge.gs 규칙)
 * ===================================================================== */

const SHEETS = { accounts: '학생계정', teachers: '교사', units: '단원', records: '평가기록부', approvals: '승인요청', social: '소셜' };
const FOLDERS = { data: '학생데이터', photos: '승인대기사진' };
const ACC_HEADER = ['학번', '이름', '비밀번호해시', '솔트', '파일ID', '가입일', '최근접속', '공개설정', '초기화'];
const ACC = { id: 0, name: 1, hash: 2, salt: 3, fileId: 4, created: 5, last: 6, privacy: 7, reset: 8 };
const UNIT_HEADER = ['단원ID', '과목', '단원명', '성취기준', '교과서 발췌(복사 차단용)', '핵심 개념 (한 줄에 하나: 용어 | 별칭1, 별칭2 | 발판 힌트)', '오개념 (한 줄에 하나: 정규식 => 힌트)', '문항 (한 줄에 하나: 객관식 | 질문 | 보기1;보기2;보기3;보기4 | 정답번호(1부터) | 힌트  또는  단답형 | 질문 | 정답1;정답2 | 힌트)', '사용'];
const APPROVAL_HEADER = ['시각', '학번', '이름', '유형', '내용', '사진 링크', '파일ID', '승인', '처리됨'];
const SOCIAL_HEADER = ['시각', '유형', '보낸 학번', '보낸 이름', '받는 학번', '키', '상태', '만료(ms)'];
const TEACHER_HEADER = ['이메일', '이름', '승인', '등록일'];
const NIGHT_LOCK = { start: 22, end: 7 };
const TOKEN_DAYS = 30;

/* ======================= 공용 ======================= */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function folder_() { const it = DriveApp.getFileById(ss_().getId()).getParents(); return it.hasNext() ? it.next() : DriveApp.getRootFolder(); }
function subfolder_(name) { const p = folder_(); const it = p.getFoldersByName(name); return it.hasNext() ? it.next() : p.createFolder(name); }
function sheet_(name, header) {
  let sh = ss_().getSheetByName(name);
  if (!sh) { sh = ss_().insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}
function props_() { return PropertiesService.getScriptProperties(); }
function secret_() { let s = props_().getProperty('SECRET'); if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props_().setProperty('SECRET', s); } return s; }
function kstNow_() { return new Date(Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy/MM/dd HH:mm:ss')); }
function todayKey_(d) { return Utilities.formatDate(d || kstNow_(), 'Asia/Seoul', 'yyyy-MM-dd'); }
function nightLocked_(d) { if (props_().getProperty('NIGHT_LOCK_OFF') === 'true') return false; const h = d.getHours(); return h >= NIGHT_LOCK.start || h < NIGHT_LOCK.end; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(error, message) { return { ok: false, error, message }; }
function cache_() { return CacheService.getScriptCache(); }
function idNum_(id) { const n = Number(id); return isNaN(n) ? String(id) : n; }

/* ======================= 인증 ======================= */
function hash_(salt, pw) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8)); }
function makeToken_(id) {
  const exp = Date.now() + TOKEN_DAYS * 86400000;
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(id + '|' + exp, secret_()));
  return id + '|' + exp + '|' + sig;
}
function verifyToken_(t) {
  if (!t) return null;
  const p = String(t).split('|'); if (p.length !== 3) return null;
  if (Number(p[1]) < Date.now()) return null;
  const want = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(p[0] + '|' + p[1], secret_()));
  return want === p[2] ? p[0] : null;
}

/* ======================= 학생 계정 ======================= */
function accountRows_() { const sh = sheet_(SHEETS.accounts, ACC_HEADER); const n = sh.getLastRow(); return n > 1 ? sh.getRange(2, 1, n - 1, ACC_HEADER.length).getValues() : []; }
function findAccount_(id) {
  const rows = accountRows_();
  for (let i = 0; i < rows.length; i++) if (String(rows[i][ACC.id]) === String(id)) return { row: i + 2, data: rows[i] };
  return null;
}
/** 자주 쓰는 계정 정보는 캐시 (비밀번호 해시는 캐시하지 않음) */
function account_(id) {
  if (String(id).startsWith('T:')) return teacherAccount_(String(id).slice(2));
  const c = cache_().get('acc_' + id);
  if (c) return JSON.parse(c);
  const a = findAccount_(id); if (!a) return null;
  const info = { id: String(id), row: a.row, name: a.data[ACC.name], fileId: a.data[ACC.fileId], privacy: a.data[ACC.privacy] || 'knock' };
  cache_().put('acc_' + id, JSON.stringify(info), 1800);
  return info;
}
function uncache_(id) { cache_().remove('acc_' + id); }

/* ---- 교사 계정: 교사 시트의 승인 이메일(또는 관리자). 상태 파일은 학생데이터/교사_<이메일>.json ---- */
function teacherName_(email) {
  const e = String(email).toLowerCase();
  const sh = sheet_(SHEETS.teachers, TEACHER_HEADER); const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, 4).getValues() : [];
  const r = rows.find(x => String(x[0]).toLowerCase() === e && x[2] === true);
  if (r) return r[1] || e.split('@')[0];
  return e === ownerEmail_().toLowerCase() ? '관리자' : null;
}
function teacherAccount_(email) {
  const e = String(email).toLowerCase();
  const name = teacherName_(e); if (!name) return null;
  const key = 'TFILE_' + e; let fileId = props_().getProperty(key);
  if (!fileId) {
    const f = subfolder_(FOLDERS.data).createFile('교사_' + e + '.json', JSON.stringify(Engine.newState({ id: 'T:' + e, name: name + ' 선생님' }, todayKey())), MimeType.PLAIN_TEXT);
    fileId = f.getId(); props_().setProperty(key, fileId);
  }
  return { id: 'T:' + e, row: 0, name: name + ' 선생님', fileId, privacy: 'private', teacher: true };
}
/** 교사 접속 코드(시트 메뉴 ⑧에서 발급한 8자리 코드)로 앱 로그인 — 시간 제한 없음 */
function teacherLogin_(body) {
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const raw = code && props_().getProperty('TCODE_' + code);
  let info = null; try { info = raw ? JSON.parse(raw) : null; } catch (e) { info = null; }
  if (!info || info.exp < Date.now()) return fail_('bad_code', '교사 접속 코드가 올바르지 않거나 만료됐어요. 시트 메뉴 ⑧에서 다시 발급하세요');
  const acc = account_('T:' + info.email); if (!acc) return fail_('not_teacher', '승인된 교사가 아니에요. 관리자에게 등록을 요청하세요');
  return { ok: true, token: makeToken_(acc.id), id: acc.id, name: acc.name, teacher: true, state: loadState_(acc, false), units: publicUnits_(loadUnits_()), inbox: { knocks: [], stickers: [] } };
}

function register_(body, today) {
  const id = String(body.id || '').trim(), name = String(body.name || '').trim(), pw = String(body.password || '');
  const join = props_().getProperty('JOIN_CODE');
  if (join && String(body.joinCode || '').trim() !== join) return fail_('bad_join', '가입 코드가 맞지 않아요. 선생님께 확인하세요');
  if (!/^\d{3,10}$/.test(id)) return fail_('bad_id', '학번은 숫자 3~10자리예요');
  if (!name || name.length > 10) return fail_('bad_name', '이름을 확인해 주세요');
  if (pw.length < 4 || pw.length > 30) return fail_('bad_pw', '비밀번호는 4자 이상이에요');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요');
  try {
    if (findAccount_(id)) return fail_('exists', '이미 만들어진 학번이에요. 비밀번호를 잊었으면 선생님께 초기화를 요청하세요');
    const salt = Utilities.getUuid();
    const state = Engine.newState({ id, name }, today);
    const file = subfolder_(FOLDERS.data).createFile(id + '.json', JSON.stringify(state), MimeType.PLAIN_TEXT);
    const sh = sheet_(SHEETS.accounts, ACC_HEADER);
    const rows = accountRows_();
    let at = rows.length + 2;
    for (let i = 0; i < rows.length; i++) { if (idNum_(id) < idNum_(rows[i][ACC.id])) { at = i + 2; break; } }
    sh.insertRowBefore(at);
    sh.getRange(at, 1, 1, ACC_HEADER.length).setValues([[id, name, hash_(salt, pw), salt, file.getId(), today, today, 'knock', false]]);
    sh.getRange(at, 1).setNumberFormat('@');
    uncache_(id);
    return { ok: true, token: makeToken_(id), name, state, units: publicUnits_(loadUnits_()), inbox: { knocks: [], stickers: [] } };
  } finally { lock.releaseLock(); }
}
function login_(body, today) {
  const id = String(body.id || '').trim(), pw = String(body.password || '');
  const failKey = 'fail_' + id;
  if (Number(cache_().get(failKey) || 0) >= 10) return fail_('locked', '비밀번호를 여러 번 틀려 10분 동안 잠겼어요');
  const a = findAccount_(id);
  if (!a || hash_(a.data[ACC.salt], pw) !== a.data[ACC.hash]) {
    cache_().put(failKey, String(Number(cache_().get(failKey) || 0) + 1), 600);
    return fail_('bad_login', '학번 또는 비밀번호가 맞지 않아요');
  }
  cache_().remove(failKey);
  sheet_(SHEETS.accounts, ACC_HEADER).getRange(a.row, ACC.last + 1).setValue(today);
  uncache_(id);
  const acc = account_(id);
  const state = loadState_(acc, true);
  return { ok: true, token: makeToken_(id), name: acc.name, state, units: publicUnits_(loadUnits_()), inbox: inbox_(acc), mustChange: a.data[ACC.reset] === true };
}
function changePassword_(acc, body) {
  const pw = String(body.password || ''); if (pw.length < 4 || pw.length > 30) return fail_('bad_pw', '비밀번호는 4자 이상이에요');
  const sh = sheet_(SHEETS.accounts, ACC_HEADER); const a = findAccount_(acc.id); if (!a) return fail_('auth');
  sh.getRange(a.row, ACC.hash + 1, 1, 2).setValues([[hash_(a.data[ACC.salt], pw), a.data[ACC.salt]]]);
  sh.getRange(a.row, ACC.reset + 1).setValue(false);
  return { ok: true };
}

/* ======================= 학생 상태 파일 ======================= */
function loadState_(acc, applyApprovals) {
  const f = DriveApp.getFileById(acc.fileId);
  let st = Engine.migrate(JSON.parse(f.getBlob().getDataAsString('UTF-8')), loadUnits_());
  if (applyApprovals && applyApprovalsFor_(acc, st)) saveState_(acc, st);
  return st;
}
function saveState_(acc, state) {
  state.updatedAt = new Date().toISOString();
  DriveApp.getFileById(acc.fileId).setContent(JSON.stringify(state));
}

/* ======================= 단원 (교사 입력, 정답은 서버에만) ======================= */
function loadUnits_() {
  const c = cache_().get('units'); if (c) return JSON.parse(c).map(reviveUnit_);
  const sh = sheet_(SHEETS.units, UNIT_HEADER); const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, UNIT_HEADER.length).getValues() : [];
  const units = rows.filter(r => r[0] && r[2] && r[8] !== false).map(parseUnit_).filter(Boolean);
  cache_().put('units', JSON.stringify(units), 300);
  return units.map(reviveUnit_);
}
function reviveUnit_(u) { u.misconceptions = (u.misconceptions || []).map(m => ({ pattern: m.pattern, hint: m.hint })); return u; }
function lines_(s) { return String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
function parts_(line) { return line.split('|').map(x => x.trim()); }
function parseUnit_(r) {
  try {
    const u = { id: String(r[0]).trim(), subject: String(r[1] || ''), title: String(r[2]), standard: String(r[3] || ''), sourceText: String(r[4] || ''), keyConcepts: [], misconceptions: [], questions: [] };
    lines_(r[5]).forEach(l => { const p = parts_(l); if (p[0]) u.keyConcepts.push({ term: p[0], aliases: (p[1] || '').split(',').map(x => x.trim()).filter(Boolean), hint: p[2] || '이 개념을 요약에 넣어 보세요.' }); });
    lines_(r[6]).forEach(l => {
      // 정규식 안에 '|' 가 들어가므로 '=>' 로 구분
      const k = l.indexOf('=>'); const pat = (k >= 0 ? l.slice(0, k) : l).trim(), hint = k >= 0 ? l.slice(k + 2).trim() : '';
      if (pat) { try { new RegExp(pat); u.misconceptions.push({ pattern: pat, hint }); } catch (e) { /* 잘못된 정규식 무시 */ } }
    });
    lines_(r[7]).forEach(l => {
      const p = parts_(l);
      if (/^객관식/.test(p[0])) u.questions.push({ type: 'mc', q: p[1], choices: (p[2] || '').split(';').map(x => x.trim()), answer: Number(p[3]) - 1, hint: p[4] || '' });
      else if (/^단답형/.test(p[0])) u.questions.push({ type: 'short', q: p[1], answers: (p[2] || '').split(';').map(x => x.trim()).filter(Boolean), hint: p[3] || '' });
    });
    // 한 행 = 성취기준(topic). 같은 단원(unitId)의 행들이 한 방으로 묶임
    u.unitId = u.id.replace(/_\d\d$/, '');
    const cm = /\[(9과\d\d-\d\d)\]/.exec(u.standard); u.code = cm ? cm[1] : '';
    return u.keyConcepts.length ? u : null;
  } catch (e) { return null; }
}
function publicUnits_(units) {
  return units.map(u => ({ id: u.id, unitId: u.unitId, code: u.code, subject: u.subject, title: u.title, standard: u.standard, conceptCount: u.keyConcepts.length,
    questions: u.questions.map(q => ({ type: q.type, q: q.q, choices: q.choices })) }));
}

/* ======================= 승인 (사진/쿠폰) ======================= */
function flushPendingApprovals_(acc, state) {
  if (!state.pendingApprovals || !state.pendingApprovals.length) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;          // 바쁘면 다음 요청 때 다시 시도
  try {
    const sh = sheet_(SHEETS.approvals, APPROVAL_HEADER);
    const now = Utilities.formatDate(kstNow_(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
    const keep = [];
    for (const p of state.pendingApprovals) {
      try {
        let link = '', fileId = '', desc = '';
        if (p.type === 'photo') {
          const r = state.rooms[p.unitId]; const it = r && r.inventory.find(i => i.uid === p.uid);
          if (!it || !it.img) continue;
          const blob = Utilities.newBlob(Utilities.base64Decode(it.img.split(',')[1]), 'image/jpeg', acc.id + '_' + p.uid + '.jpg');
          const f = subfolder_(FOLDERS.photos).createFile(blob);
          link = f.getUrl(); fileId = f.getId(); desc = '사진 액자 (' + p.unitId + ' 방, uid ' + p.uid + ')';
        } else desc = '쿠폰: ' + p.name;
        sh.appendRow([now, acc.id, acc.name, p.type, desc, link, fileId, false, false]);
        sh.getRange(sh.getLastRow(), 8, 1, 2).insertCheckboxes();
        sh.getRange(sh.getLastRow(), 2).setNumberFormat('@');
      } catch (e) { keep.push(p); }
    }
    state.pendingApprovals = keep;
  } finally { lock.releaseLock(); }
}
/** 승인요청 시트에서 이 학생의 승인된 항목을 상태에 반영. 변경 있으면 true */
function applyApprovalsFor_(acc, state) {
  const sh = sheet_(SHEETS.approvals, APPROVAL_HEADER); const n = sh.getLastRow(); if (n < 2) return false;
  const rows = sh.getRange(2, 1, n - 1, APPROVAL_HEADER.length).getValues();
  let changed = false;
  rows.forEach((r, i) => {
    if (String(r[1]) !== String(acc.id) || r[7] !== true || r[8] === true) return;
    if (r[3] === 'photo') {
      const m = /uid (\d+)/.exec(r[4]); const uid = m ? Number(m[1]) : -1;
      Object.keys(state.rooms).forEach(k => state.rooms[k].inventory.forEach(it => { if (it.uid === uid && it.id === 'photo_frame') { it.approved = true; changed = true; } }));
      if (r[6]) { try { DriveApp.getFileById(r[6]).setTrashed(true); } catch (e) { /* ignore */ } }
    } else if (r[3] === 'coupon') {
      const name = String(r[4]).replace(/^쿠폰:\s*/, '');
      const c = state.coupons.find(x => x.name === name && x.status === 'pending'); if (c) { c.status = 'approved'; changed = true; }
    }
    sh.getRange(i + 2, 9).setValue(true);
  });
  return changed;
}

/* ======================= 소셜 (노크 / 허락 / 스티커) — 별도 시트, 학생 파일은 본인만 수정 ======================= */
function socialRows_() { const sh = sheet_(SHEETS.social, SOCIAL_HEADER); const n = sh.getLastRow(); return n > 1 ? sh.getRange(2, 1, n - 1, SOCIAL_HEADER.length).getValues() : []; }
function socialAppend_(type, from, fromName, to, key, status, expires) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('busy');
  try {
    const sh = sheet_(SHEETS.social, SOCIAL_HEADER);
    sh.appendRow([Date.now(), type, String(from), fromName, String(to), key || '', status || '', expires || '']);
    sh.getRange(sh.getLastRow(), 3, 1, 1).setNumberFormat('@'); sh.getRange(sh.getLastRow(), 5, 1, 1).setNumberFormat('@');
  } finally { lock.releaseLock(); }
}
function classOf_(id) { const s = String(id); return s.length > 2 ? s.slice(0, s.length - 2) : s; }
function classmates_(acc) {
  const mine = classOf_(acc.id);
  const list = accountRows_().filter(r => acc.teacher || (String(r[ACC.id]) !== String(acc.id) && classOf_(r[ACC.id]) === mine))
    .map(r => ({ id: String(r[ACC.id]), name: (acc.teacher ? r[ACC.id] + ' ' : '') + r[ACC.name], privacy: r[ACC.privacy] || 'knock' }));
  return { ok: true, list: list.slice(0, acc.teacher ? 400 : 80) };
}
function visitStatus_(visitor, target) {
  if (target.privacy === 'private') return 'private';
  if (target.privacy === 'open') return 'ok';
  const now = Date.now(); let pending = false;
  for (const r of socialRows_()) {
    if (String(r[2]) !== String(target.id) && String(r[2]) !== String(visitor.id)) continue;
    if (r[1] === 'allow' && String(r[2]) === String(target.id) && String(r[4]) === String(visitor.id) && Number(r[7]) > now) return 'ok';
    if (r[1] === 'knock' && String(r[2]) === String(visitor.id) && String(r[4]) === String(target.id) && r[6] === 'pending' && now - Number(r[0]) < 86400000) pending = true;
  }
  return pending ? 'pending' : 'none';
}
function knock_(acc, body) {
  const target = account_(String(body.targetId || '')); if (!target) return fail_('no_target', '친구를 찾을 수 없어요');
  if (acc.teacher) return { ok: true, status: 'allowed' };
  if (classOf_(target.id) !== classOf_(acc.id)) return fail_('not_class', '같은 반 친구만 방문할 수 있어요');
  const st = visitStatus_(acc, target);
  if (st === 'private') return fail_('private', '이 친구는 방을 닫아 두었어요');
  if (st === 'ok') return { ok: true, status: 'allowed' };
  if (st === 'pending') return { ok: true, status: 'pending' };
  socialAppend_('knock', acc.id, acc.name, target.id, '', 'pending', '');
  return { ok: true, status: 'pending' };
}
function allow_(acc, body) {
  const visitor = String(body.visitorId || '');
  const sh = sheet_(SHEETS.social, SOCIAL_HEADER); const rows = socialRows_();
  rows.forEach((r, i) => { if (r[1] === 'knock' && String(r[2]) === visitor && String(r[4]) === String(acc.id) && r[6] === 'pending') sh.getRange(i + 2, 7).setValue(body.allow ? 'allowed' : 'denied'); });
  if (body.allow) socialAppend_('allow', acc.id, acc.name, visitor, '', 'allowed', Date.now() + CONFIG.visitMinutes * 60000);
  return { ok: true };
}
function visit_(acc, body) {
  const target = account_(String(body.targetId || '')); if (!target) return fail_('no_target', '친구를 찾을 수 없어요');
  if (!acc.teacher && classOf_(target.id) !== classOf_(acc.id)) return fail_('not_class', '같은 반 친구만 방문할 수 있어요');
  const st = acc.teacher ? 'ok' : visitStatus_(acc, target);   // 교사는 지도 목적상 모든 학생 방 열람 가능
  if (st !== 'ok') return { ok: true, status: st };
  const view = Engine.publicView(loadState_(target, false));
  const myStickers = socialRows_().filter(r => r[1] === 'sticker' && String(r[2]) === String(acc.id) && String(r[4]) === String(target.id)).map(r => String(r[5]));
  return { ok: true, status: 'ok', view, myStickers };
}
function sticker_(acc, body, today) {
  const target = account_(String(body.targetId || '')); if (!target) return fail_('no_target');
  if (!acc.teacher && visitStatus_(acc, target) !== 'ok') return fail_('not_allowed', '먼저 방에 들어가야 해요');
  const key = String(body.key || '');
  const rows = socialRows_();
  if (rows.some(r => r[1] === 'sticker' && String(r[2]) === String(acc.id) && String(r[4]) === String(target.id) && String(r[5]) === key)) return fail_('dup', '이미 스티커를 남겼어요');
  socialAppend_('sticker', acc.id, acc.name, target.id, key, today, '');
  const state = loadState_(acc, false);
  const n = (state.stickerLog[today] || 0);
  let msg = '영감 스티커를 남겼어요!';
  if (n < CONFIG.sticker.perDay) { state.coins += CONFIG.sticker.coin; state.stickerLog[today] = n + 1; msg += ` (+${CONFIG.sticker.coin} 코인)`; }
  saveState_(acc, state);
  return { ok: true, coins: state.coins, message: msg };
}
function inbox_(acc) {
  const now = Date.now(); const knocks = [], stickers = [];
  socialRows_().forEach(r => {
    if (String(r[4]) !== String(acc.id)) return;
    if (r[1] === 'knock' && r[6] === 'pending' && now - Number(r[0]) < 86400000) knocks.push({ from: String(r[2]), name: r[3], at: Number(r[0]) });
    if (r[1] === 'sticker') stickers.push({ from: String(r[2]), name: r[3], key: String(r[5]), date: String(r[6]) });
  });
  return { knocks, stickers: stickers.slice(-100).reverse() };
}

/* ======================= HTTP 진입점 ======================= */
function doGet(e) {
  const now = kstNow_();
  return json_({ ok: true, app: 'studyroom', serverTime: now.toISOString(), locked: nightLocked_(now) });
}
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_(fail_('bad_json')); }
  const now = kstNow_(), today = todayKey_(now);
  const tokenId = verifyToken_(body.token);
  const isTeacher = !!tokenId && tokenId.startsWith('T:');
  try {
    const a = body.action;
    if (a === 'teacherLogin') return json_(teacherLogin_(body));          // 교사는 시간 제한 없음
    if (!isTeacher && nightLocked_(now)) return json_(fail_('night_lock', '지금은 쿨쿨 잘 시간이에요! 내일 아침 7시에 만나요'));
    if (a === 'register') return json_(register_(body, today));
    if (a === 'login') return json_(login_(body, today));
    const id = tokenId; if (!id) return json_(fail_('auth', '다시 로그인해 주세요'));
    const acc = account_(id); if (!acc) return json_(fail_('auth', '계정을 찾을 수 없어요'));
    switch (a) {
      case 'load': return json_({ ok: true, state: loadState_(acc, true), units: publicUnits_(loadUnits_()), inbox: inbox_(acc) });
      case 'cmd': return json_(command_(acc, body.cmd, today));
      case 'grade': {
        const u = loadUnits_().find(x => x.id === (body.topicId || body.unitId)); if (!u) return json_(fail_('no_unit', '성취기준을 찾을 수 없어요'));
        return json_({ ok: true, result: Engine.grade(u, body.answers || {}) });
      }
      case 'changePassword': return json_(changePassword_(acc, body));
      case 'classmates': return json_(classmates_(acc));
      case 'knock': return json_(knock_(acc, body));
      case 'allow': return json_(allow_(acc, body));
      case 'visit': return json_(visit_(acc, body));
      case 'sticker': return json_(sticker_(acc, body, today));
      case 'inbox': return json_({ ok: true, inbox: inbox_(acc) });
      default: return json_(fail_('unknown_action'));
    }
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/busy|Lock|too many|simultaneous/i.test(msg)) return json_(fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요'));
    return json_(fail_('server', msg));
  }
}
/** 게임 명령: 서버의 Engine 이 코인·보상·판정을 결정 */
function command_(acc, cmd, today) {
  if (!cmd || typeof cmd !== 'object') return fail_('bad_cmd');
  const units = loadUnits_();
  const state = loadState_(acc, false);
  const r = Engine.apply(state, cmd, { topics: units, units, today, rng: Math.random });
  if (!r.ok) return fail_('rejected', r.error);
  if (cmd.type === 'settings' && acc.row > 0) { sheet_(SHEETS.accounts, ACC_HEADER).getRange(acc.row, ACC.privacy + 1).setValue(state.settings.privacy); uncache_(acc.id); }
  flushPendingApprovals_(acc, state);
  saveState_(acc, state);
  return { ok: true, result: r.result || null, state };
}

/* ======================= 교사 메뉴 (구글 계정 + 관리자 승인) ======================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🏠 스터디룸')
    .addItem('① 초기 설치 (관리자)', 'setup')
    .addItem('② 예시 단원 채우기', 'fillSampleUnits')
    .addSeparator()
    .addItem('③ 평가기록부 지금 갱신', 'syncRecords')
    .addItem('④ 승인 처리 적용', 'applyApprovals')
    .addItem('⑤ 학생 비밀번호 초기화', 'resetPassword')
    .addSeparator()
    .addItem('⑥ 교사 등록 승인 (관리자)', 'approveTeacherPrompt')
    .addItem('⑦ 심야 잠금 켜기/끄기 (테스트)', 'toggleNightLock')
    .addItem('⑧ 내 교사 접속 코드 보기', 'showTeacherCode')
    .addItem('⑨ 가입 코드 설정 (관리자)', 'setJoinCode')
    .addItem('상태 확인', 'showStatus')
    .addToUi();
}
function ownerEmail_() { return DriveApp.getFileById(ss_().getId()).getOwner().getEmail(); }
function me_() { return Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail(); }
function isAdmin_() { return me_() && me_() === ownerEmail_(); }
function requireTeacher_() {
  const email = me_();
  if (isAdmin_()) return email;
  const sh = sheet_(SHEETS.teachers, ['이메일', '이름', '승인', '등록일']); const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, 4).getValues() : [];
  if (rows.some(r => String(r[0]).toLowerCase() === String(email).toLowerCase() && r[2] === true)) return email;
  throw new Error('승인된 교사만 사용할 수 있어요. 관리자에게 등록을 요청하세요. (' + email + ')');
}
function requireAdmin_() { if (!isAdmin_()) throw new Error('관리자(시트 소유자)만 할 수 있어요.'); }
function alert_(m) { SpreadsheetApp.getUi().alert(m); }

function setup() {
  requireAdmin_();
  sheet_(SHEETS.accounts, ACC_HEADER); sheet_(SHEETS.teachers, ['이메일', '이름', '승인', '등록일']);
  sheet_(SHEETS.units, UNIT_HEADER); sheet_(SHEETS.records, ['학번', '이름']);
  sheet_(SHEETS.approvals, APPROVAL_HEADER); sheet_(SHEETS.social, SOCIAL_HEADER);
  subfolder_(FOLDERS.data); subfolder_(FOLDERS.photos); secret_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'syncRecords') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncRecords').timeBased().everyMinutes(10).create();
  alert_('설치 완료!\n\n폴더: ' + folder_().getName() + '\n\n다음 단계: 배포 → 새 배포 → 웹 앱 (실행 계정: 나 / 액세스: 모든 사용자) 후 URL 을 js/catalog.js 의 CONFIG.gasUrl 에 넣으세요.\n"② 예시 단원 채우기"로 단원 시트 형식을 확인할 수 있어요.');
}
function fillSampleUnits() {
  requireTeacher_();
  if (typeof UNITS === 'undefined') return alert_('units.gs 파일(js/units.js 내용)을 프로젝트에 추가한 뒤 다시 실행하세요.');
  const sh = sheet_(SHEETS.units, UNIT_HEADER);
  const toRow = u => [u.id, u.subject, u.title, u.standard, u.sourceText,
    u.keyConcepts.map(c => [c.term, (c.aliases || []).join(', '), c.hint].join(' | ')).join('\n'),
    (u.misconceptions || []).map(m => (m.pattern.source || m.pattern) + ' => ' + m.hint).join('\n'),
    u.questions.map(q => q.type === 'mc' ? ['객관식', q.q, q.choices.join(';'), q.answer + 1, q.hint].join(' | ') : ['단답형', q.q, q.answers.join(';'), q.hint].join(' | ')).join('\n'),
    true];
  // 초기 버전의 예시 단원(과학 외 과목 포함)은 자동 삭제
  // (초기 예시 4개 + 대단원 단위였던 23개 행. 지금은 한 행 = 성취기준 하나)
  const LEGACY_IDS = ['sci_state', 'sci_photo', 'his_sabi', 'math_eq'];
  for (let i = 1; i <= 23; i++) LEGACY_IDS.push((i <= 7 ? 'sci1_' : i <= 15 ? 'sci2_' : 'sci3_') + ('0' + i).slice(-2));
  let removed = 0;
  for (let r = sh.getLastRow(); r >= 2; r--) { if (LEGACY_IDS.includes(String(sh.getRange(r, 1).getValue()))) { sh.deleteRow(r); removed++; } }
  // 같은 단원ID 는 덮어쓰고(upsert), 없는 것만 추가 → 여러 번 눌러도 중복되지 않음
  const n = sh.getLastRow();
  const ids = n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(r => String(r[0])) : [];
  let updated = 0; const added = [];
  UNITS.forEach(u => {
    const i = ids.indexOf(u.id);
    if (i >= 0) { const row = toRow(u); row[8] = sh.getRange(i + 2, 9).getValue() !== false; sh.getRange(i + 2, 1, 1, UNIT_HEADER.length).setValues([row]); updated++; }
    else added.push(toRow(u));
  });
  if (added.length) {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, added.length, UNIT_HEADER.length).setValues(added);
    sh.getRange(start, 9, added.length, 1).insertCheckboxes();
  }
  sh.setColumnWidths(4, 5, 320); sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), UNIT_HEADER.length).setWrap(true).setVerticalAlignment('top');
  cache_().remove('units');
  alert_('단원 시트 갱신: 추가 ' + added.length + '개, 덮어쓰기 ' + updated + '개' + (removed ? ', 예전 예시 삭제 ' + removed + '개' : '') + '. (학생 화면에는 5분 이내 반영)\n"사용" 체크를 끄면 학생에게 보이지 않아요.');
}
function syncRecords() {
  const sh = sheet_(SHEETS.records, ['학번', '이름']);
  const rows = accountRows_();
  const dates = new Set(); const data = [];
  rows.forEach(r => {
    try {
      const st = JSON.parse(DriveApp.getFileById(r[ACC.fileId]).getBlob().getDataAsString('UTF-8'));
      (st.records || []).forEach(x => dates.add(x.date));
      data.push({ id: r[ACC.id], name: r[ACC.name], records: st.records || [] });
    } catch (e) { data.push({ id: r[ACC.id], name: r[ACC.name], records: [] }); }
  });
  const cols = Array.from(dates).sort();
  const out = [['학번', '이름'].concat(cols.map(d => d.slice(5).replace('-', '/')))];
  data.forEach(d => out.push([d.id, d.name].concat(cols.map(c => d.records.filter(x => x.date === c)
    .map(x => `[${x.topicId || x.unitId}] ${x.pass ? '통과' : '재도전'} ${x.score}점 · 개념 ${(x.opened || x.hits || []).length}개 · 퀴즈 ${x.quiz ? x.quiz.correct + '/' + x.quiz.total : '-'} · ${x.attempts}회\n${x.summary}`).join('\n\n')))));
  sh.clearContents();
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  sh.getRange(2, 1, Math.max(1, out.length - 1), 1).setNumberFormat('@');
  sh.setFrozenRows(1); sh.setFrozenColumns(2);
  // 소셜 로그 7일 지난 행 정리
  const so = sheet_(SHEETS.social, SOCIAL_HEADER); const sr = socialRows_(); const cutoff = Date.now() - 7 * 86400000;
  for (let i = sr.length - 1; i >= 0; i--) if (Number(sr[i][0]) < cutoff) so.deleteRow(i + 2);
}
function applyApprovals() {
  requireTeacher_();
  const sh = sheet_(SHEETS.approvals, APPROVAL_HEADER); const n = sh.getLastRow(); if (n < 2) return alert_('대기 중인 요청이 없어요.');
  const ids = new Set(sh.getRange(2, 1, n - 1, APPROVAL_HEADER.length).getValues().filter(r => r[7] === true && r[8] !== true).map(r => String(r[1])));
  let cnt = 0;
  ids.forEach(id => { const acc = account_(id); if (!acc) return; const st = loadState_(acc, false); if (applyApprovalsFor_(acc, st)) { saveState_(acc, st); cnt++; } });
  alert_(cnt + '명의 승인을 반영했어요. (학생이 다음에 접속할 때도 자동 반영돼요)');
}
function resetPassword() {
  requireTeacher_();
  const ui = SpreadsheetApp.getUi(); const r = ui.prompt('비밀번호 초기화', '학번을 입력하세요. 임시 비밀번호는 "0000"이 되고, 학생이 다음 로그인 때 새 비밀번호를 정해요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const a = findAccount_(r.getResponseText().trim()); if (!a) return alert_('학번을 찾을 수 없어요.');
  const sh = sheet_(SHEETS.accounts, ACC_HEADER);
  sh.getRange(a.row, ACC.hash + 1).setValue(hash_(a.data[ACC.salt], '0000')); sh.getRange(a.row, ACC.reset + 1).setValue(true);
  cache_().remove('fail_' + a.data[ACC.id]);
  alert_('초기화했어요. 임시 비밀번호: 0000');
}
function approveTeacherPrompt() {
  requireAdmin_();
  const ui = SpreadsheetApp.getUi(); const r = ui.prompt('교사 등록 승인', '교사의 구글 이메일을 입력하세요. 폴더가 공유되고 교사 시트에 등록돼요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const email = r.getResponseText().trim().toLowerCase(); if (!/@/.test(email)) return alert_('이메일 형식이 아니에요.');
  const sh = sheet_(SHEETS.teachers, ['이메일', '이름', '승인', '등록일']); const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, 4).getValues() : [];
  const i = rows.findIndex(x => String(x[0]).toLowerCase() === email);
  if (i >= 0) sh.getRange(i + 2, 3).setValue(true); else { sh.appendRow([email, '', true, todayKey_()]); sh.getRange(sh.getLastRow(), 3).insertCheckboxes().setValue(true); }
  try { folder_().addEditor(email); } catch (e) { /* 공유 실패 시 수동 공유 */ }
  alert_(email + ' 을(를) 교사로 승인하고 폴더를 공유했어요.');
}
function toggleNightLock() {
  requireTeacher_();
  const off = props_().getProperty('NIGHT_LOCK_OFF') === 'true';
  props_().setProperty('NIGHT_LOCK_OFF', off ? 'false' : 'true');
  alert_('심야 잠금: ' + (off ? '켜짐 (22:00~07:00 차단)' : '꺼짐 (테스트 모드)'));
}
function showTeacherCode() {
  const email = String(requireTeacher_()).toLowerCase();
  // 교사별 8자리 코드(30일). 이미 유효한 코드가 있으면 재사용
  const key = 'TCODE_OF_' + email;
  let code = props_().getProperty(key); let info = null;
  if (code) { try { info = JSON.parse(props_().getProperty('TCODE_' + code) || 'null'); } catch (e) { info = null; } }
  if (!info || info.exp < Date.now() || info.email !== email) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; code = '';
    for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    info = { email, exp: Date.now() + TOKEN_DAYS * 86400000 };
    props_().setProperty('TCODE_' + code, JSON.stringify(info)); props_().setProperty(key, code);
  }
  const pretty = code.slice(0, 4) + '-' + code.slice(4);
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;padding:8px 4px">' +
    '<p style="margin:0 0 8px">교사 접속 코드 (30일 유효, 본인만 사용)</p>' +
    '<input id="c" value="' + pretty + '" readonly style="font-size:28px;letter-spacing:4px;text-align:center;width:100%;padding:10px;border:2px solid #f59e0b;border-radius:10px;font-weight:bold" onclick="this.select()">' +
    '<p style="margin:10px 0 0;font-size:13px;color:#555">학생용 앱 로그인 화면 → <b>교사로 접속</b> → 이 코드를 입력하세요. (하이픈은 없어도 돼요)<br>심야·수업 시간 잠금 없이 쓸 수 있고 모든 학생 방을 볼 수 있어요.</p>' +
    '<button onclick="var i=document.getElementById(\'c\');i.select();document.execCommand(\'copy\');this.textContent=\'복사됨!\'" style="margin-top:10px;padding:8px 14px;border:0;border-radius:8px;background:#f59e0b;color:#fff;font-weight:bold;cursor:pointer">복사</button>' +
    '</div>').setWidth(420).setHeight(230);
  SpreadsheetApp.getUi().showModalDialog(html, '👩‍🏫 교사 접속 코드');
}
function setJoinCode() {
  requireAdmin_();
  const ui = SpreadsheetApp.getUi();
  const cur = props_().getProperty('JOIN_CODE') || '(없음)';
  const r = ui.prompt('가입 코드 설정', '학생이 처음 학번을 만들 때 입력해야 하는 코드예요. 공개 호스팅(GitHub/Firebase)에서 아무나 가입하는 것을 막아요.\n현재: ' + cur + '\n비워 두면 코드 없이 가입할 수 있어요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const v = r.getResponseText().trim();
  if (v) props_().setProperty('JOIN_CODE', v); else props_().deleteProperty('JOIN_CODE');
  alert_('가입 코드: ' + (v || '(없음)') + '\n학생들에게 수업 시간에 알려 주세요.');
}
function showStatus() {
  requireTeacher_();
  alert_('폴더: ' + folder_().getName() + '\n학생 수: ' + accountRows_().length + '\n단원 수: ' + loadUnits_().length + '\n심야 잠금: ' + (props_().getProperty('NIGHT_LOCK_OFF') === 'true' ? '꺼짐' : '켜짐') + '\n가입 코드: ' + (props_().getProperty('JOIN_CODE') ? '설정됨' : '없음') + '\n관리자: ' + ownerEmail_() + '\n나: ' + me_());
}
