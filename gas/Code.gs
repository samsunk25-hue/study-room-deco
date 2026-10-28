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

const SHEETS = { accounts: '학생계정', teachers: '교사', units: '단원', questions: '문항', records: '평가기록부', approvals: '승인요청', past: '지난계정', social: '소셜' };
// 문항 시트: 한 행 = 문항 하나. 성취기준ID 는 단원 시트의 단원ID(예: sci2_14_02). 이 시트에 행이 있는 성취기준은 단원 시트의 문항 칸 대신 이 행들을 사용
const QUESTION_HEADER = ['성취기준ID', '유형(객관식/단답형)', '질문', '보기1', '보기2', '보기3', '보기4', '정답(객관식: 번호 1~4 / 단답형: 정답1;정답2)', '힌트', '사용'];
const COUPON_HEADER = ['쿠폰ID', '이름', '코인', '설명', '사용'];
SHEETS.coupons = '쿠폰';

/* ======================= 쿠폰 (교사가 시트 또는 앱 교사 모드에서 관리) ======================= */
function loadCoupons_() {
  const c = cache_().get('coupons'); if (c) return JSON.parse(c);
  const sh = sheet_(SHEETS.coupons, COUPON_HEADER); const n = sh.getLastRow();
  let rows = n > 1 ? sh.getRange(2, 1, n - 1, COUPON_HEADER.length).getValues() : [];
  if (!rows.length) {                                     // 비어 있으면 기본 쿠폰으로 채움
    rows = CONFIG.coupons.map(cp => [cp.id, cp.name, cp.cost, cp.desc, true]);
    sh.getRange(2, 1, rows.length, COUPON_HEADER.length).setValues(rows);
    sh.getRange(2, 5, rows.length, 1).insertCheckboxes();
  }
  const list = rows.filter(r => r[0] && r[1] && r[4] !== false).map(r => ({ id: String(r[0]).trim(), name: String(r[1]).trim(), cost: Math.max(0, Number(r[2]) || 0), desc: String(r[3] || '') }));
  cache_().put('coupons', JSON.stringify(list), 300);
  return list;
}
function saveCoupons_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const list = (Array.isArray(body.coupons) ? body.coupons : []).map(c => ({
    id: String(c.id || '').trim() || ('cp' + Date.now().toString(36)), name: String(c.name || '').trim(), cost: Math.max(0, Number(c.cost) || 0), desc: String(c.desc || '').trim(),
  })).filter(c => c.name);
  if (list.length > 20) return fail_('too_many', '쿠폰은 20개까지예요');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요');
  try {
    const sh = sheet_(SHEETS.coupons, COUPON_HEADER);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    if (list.length) { sh.getRange(2, 1, list.length, COUPON_HEADER.length).setValues(list.map(c => [c.id, c.name, c.cost, c.desc, true])); sh.getRange(2, 5, list.length, 1).insertCheckboxes(); }
    cache_().remove('coupons');
  } finally { lock.releaseLock(); }
  return { ok: true, coupons: list };
}

/* ======================= 이벤트 (교사가 앱 교사 모드나 시트에서 추가·수정) ======================= */
const EVENT_HEADER = ['이벤트ID', '이름', '시작일(YYYY-MM-DD)', '종료일(YYYY-MM-DD)', '한정 가구(아이템ID; 로 구분)', '드롭 확률(0~1)', '강제 활성화', '사용'];
SHEETS.events = '이벤트';
function dateStr_(v) { if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd'); return String(v || '').trim().slice(0, 10); }
function loadEvents_() {
  const c = cache_().get('events'); if (c) return JSON.parse(c);
  const sh = sheet_(SHEETS.events, EVENT_HEADER); const n = sh.getLastRow();
  let rows = n > 1 ? sh.getRange(2, 1, n - 1, EVENT_HEADER.length).getValues() : [];
  if (!rows.length) {                                       // 비어 있으면 기본 이벤트로 채움
    const e = CONFIG.event;
    rows = [['default', e.name, e.start, e.end, (e.itemIds || []).join(';'), e.dropRate, false, true]];
    sh.getRange(2, 1, 1, EVENT_HEADER.length).setValues(rows); sh.getRange(2, 7, 1, 2).insertCheckboxes(); sh.getRange(2, 8).setValue(true);
    sh.getRange('C2:D200').setNumberFormat('@');
  }
  const list = rows.filter(r => r[0] && r[1] && r[7] !== false).map(r => ({
    id: String(r[0]).trim(), name: String(r[1]).trim(), start: dateStr_(r[2]), end: dateStr_(r[3]),
    itemIds: String(r[4] || '').split(';').map(x => x.trim()).filter(Boolean), dropRate: Math.min(1, Math.max(0, Number(r[5]) || 0)), force: r[6] === true,
  }));
  cache_().put('events', JSON.stringify(list), 300);
  return list;
}
function saveEvents_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const list = (Array.isArray(body.events) ? body.events : []).map(e => ({
    id: String(e.id || '').trim() || ('ev' + Date.now().toString(36)), name: String(e.name || '').trim(), start: dateStr_(e.start), end: dateStr_(e.end),
    itemIds: (e.itemIds || []).map(x => String(x).trim()).filter(x => ITEMS[x]), dropRate: Math.min(1, Math.max(0, Number(e.dropRate) || 0)), force: !!e.force,
  })).filter(e => e.name);
  if (list.length > 20) return fail_('too_many', '이벤트는 20개까지예요');
  for (const e of list) if (!/^\d{4}-\d{2}-\d{2}$/.test(e.start) || !/^\d{4}-\d{2}-\d{2}$/.test(e.end)) return fail_('bad_date', '날짜는 YYYY-MM-DD 형식이어야 해요: ' + e.name);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요');
  try {
    const sh = sheet_(SHEETS.events, EVENT_HEADER);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    if (list.length) {
      sh.getRange(2, 1, list.length, EVENT_HEADER.length).setValues(list.map(e => [e.id, e.name, e.start, e.end, e.itemIds.join(';'), e.dropRate, e.force, true]));
      sh.getRange(2, 7, list.length, 2).insertCheckboxes(); sh.getRange(2, 3, list.length, 2).setNumberFormat('@');
      list.forEach((e, i) => sh.getRange(i + 2, 7, 1, 2).setValues([[e.force, true]]));
    }
    cache_().remove('events');
  } finally { lock.releaseLock(); }
  return { ok: true, events: list };
}

/* ======================= 테스트 자료 (교사): 개념도 액자 등 확인용 ======================= */
function seedTest_(acc, body, today) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const id = String(body.studentId || '').trim();
  const sacc = account_(id); if (!sacc) return fail_('no_student', '학번 ' + id + ' 학생을 찾을 수 없어요');
  const units = loadUnits_(); if (!units.length) return fail_('no_units', '단원이 없어요');
  const st = loadState_(sacc, false);
  // 한 단원(성취기준 수가 가장 적은 단원)의 성취기준을 모두 통과한 기록을 넣어 개념도 액자 조건을 바로 만족시킴
  const byUnit = {}; units.forEach(u => (byUnit[u.unitId] = byUnit[u.unitId] || []).push(u));
  const unitId = Object.keys(byUnit).filter(k => !st.conceptMaps[k]).sort((a, b) => byUnit[a].length - byUnit[b].length)[0] || Object.keys(byUnit)[0];
  const picked = byUnit[unitId];
  const day = Number(today.slice(8, 10)), month = today.slice(0, 7);
  const days = []; for (let d = day; d >= 1 && days.length < picked.length; d--) days.push(month + '-' + (d < 10 ? '0' : '') + d);
  while (days.length < picked.length) days.push(today);
  let added = 0;
  picked.forEach((u, i) => {
    const date = days[i];
    if (st.records.some(r => r.pass && r.topicId === u.id)) return;
    const hits = u.keyConcepts.slice(0, 4).map(c => c.term);
    st.records.push({ date, topicId: u.id, unitId: u.unitId, attempts: 1, quizRewarded: true, passRewarded: true, opened: hits, quiz: { correct: 2, total: 2 },
      summary: '[테스트 자료] ' + hits.join(', ') + ' 개념을 연결해 설명한 요약이에요.', score: 85, pass: true, hits, reason: 'ok', reward: { coins: 90, itemId: null } });
    const itemId = Engine.rollItem(st, today, Math.random, loadEvents_());          // 통과 보상 가구도 함께
    Engine.addItem(st, u.unitId, itemId, today); st.records[st.records.length - 1].reward.itemId = itemId; st.coins += 90;
    added++;
  });
  saveState_(sacc, st); cache_().remove('allsum');
  return { ok: true, added, unitId, message: `${sacc.name}(${id})에게 "${picked[0].title}" 단원 성취기준 ${picked.length}개 통과 기록을 넣었어요(새로 ${added}건). 학생이 서재에서 그 단원 개념도 액자를 만들 수 있어요.` };
}

/* ======================= 문항 자동 생성 (교사 · 규칙 기반, 외부 AI 사용 안 함) ======================= */
function escRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function shuffle_(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function sentencesOf_(text) { return String(text || '').replace(/\r/g, '').split(/(?<=[.!?。])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 8); }
function genQuestions_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const id = String(body.topicId || '').trim();
  const units = loadUnits_(); const u = units.find(x => x.id === id);
  if (!u) return fail_('no_unit', '성취기준을 찾을 수 없어요');
  const count = Math.min(10, Math.max(1, Math.round(Number(body.count) || 5)));
  const sents = sentencesOf_(u.sourceText);
  const terms = u.keyConcepts.map(c => c.term);
  const sib = []; units.forEach(x => { if (x.unitId === u.unitId && x.id !== u.id) x.keyConcepts.forEach(c => { if (!terms.includes(c.term) && !sib.includes(c.term)) sib.push(c.term); }); });
  const isQ = h => /[?？]\s*$|써 보세요|쓰세요|적어 보세요|무엇|이름은/.test(String(h || ''));
  const mc = [], sh = [];
  u.keyConcepts.forEach(c => {
    const sent = sents.find(s => s.includes(c.term));
    const cloze = sent ? sent.replace(new RegExp(escRe_(c.term), 'g'), '(　　)') : '';
    const dHint = isQ(c.hint) ? c.hint : (c.hint || '핵심 개념어를 떠올려 보세요.');
    if (cloze) {
      const pool = shuffle_(terms.filter(t => t !== c.term)).concat(shuffle_(sib.slice())).slice(0, 3);
      if (pool.length >= 2) { const choices = shuffle_(pool.concat([c.term])); mc.push({ type: 'mc', q: '빈칸에 알맞은 말은? "' + cloze + '"', choices, answer: choices.indexOf(c.term), hint: dHint }); }
    }
    if (isQ(c.hint)) sh.push({ type: 'short', q: c.hint, answers: [c.term], hint: cloze ? '본문: ' + cloze.slice(0, 70) : '핵심 개념어 한 단어로 써 보세요.' });
    else if (cloze) sh.push({ type: 'short', q: '빈칸에 알맞은 말을 쓰세요. "' + cloze + '"', answers: [c.term], hint: dHint });
  });
  const mixed = [];
  while ((mc.length || sh.length) && mixed.length < count) { if (mc.length) mixed.push(mc.shift()); if (sh.length && mixed.length < count) mixed.push(sh.shift()); }
  if (!mixed.length) return fail_('empty', '이 성취기준에는 자동 생성에 쓸 핵심 개념·본문이 부족해요');
  return { ok: true, questions: mixed };
}

/* ======================= 코인 일괄 지급 (교사) ======================= */
function grantCoins_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const amount = Math.round(Number(body.amount));
  if (!(amount >= 1 && amount <= 10000)) return fail_('bad_amount', '금액은 1~10000 사이여야 해요');
  const rows = accountRows_();
  let targets = rows;
  if (Array.isArray(body.ids) && body.ids.length) { const want = new Set(body.ids.map(x => String(x).trim())); targets = rows.filter(r => want.has(String(r[ACC.id]))); }
  if (!targets.length) return fail_('no_target', '대상 학생이 없어요');
  if (targets.length > 300) return fail_('too_many', '한 번에 300명까지 지급할 수 있어요');
  let done = 0; const failed = [];
  targets.forEach(r => {
    try {
      const sacc = { id: String(r[ACC.id]), row: 0, name: r[ACC.name], fileId: r[ACC.fileId], privacy: r[ACC.privacy] || 'knock' };
      const st = loadState_(sacc, false); st.coins += amount; saveState_(sacc, st); done++;
    } catch (e) { failed.push(String(r[ACC.id])); }
  });
  return { ok: true, done, failed, message: '학생 ' + done + '명에게 🪙 ' + amount + '씩 지급했어요' + (failed.length ? ' (실패: ' + failed.join(', ') + ')' : '') };
}
/* ======================= 가구별 개별 가격 (교사) ======================= */
function itemPrices_() { try { return JSON.parse(props_().getProperty('ITEM_PRICES') || '{}'); } catch (e) { return {}; } }
function applyItemPrices_() { const m = itemPrices_(); Object.keys(m).forEach(id => { if (ITEMS[id] && !ITEMS[id].custom) ITEMS[id].cost = m[id] > 0 ? Number(m[id]) : undefined; }); }
function saveItemPrices_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const src = body.prices && typeof body.prices === 'object' ? body.prices : {};
  const out = {}; Object.keys(src).forEach(id => { if (!ITEMS[id]) return; const v = Number(src[id]); if (v > 0 && v <= 100000) out[id] = Math.round(v); });
  props_().setProperty('ITEM_PRICES', JSON.stringify(out));
  return { ok: true, itemPrices: out };
}

/* ======================= 교사 승인 (앱 교사 모드) ======================= */
function approvals_(acc) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const sh = sheet_(SHEETS.approvals, APPROVAL_HEADER); const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, APPROVAL_HEADER.length).getValues() : [];
  const list = [];
  rows.forEach((r, i) => {
    if (r[8] === true) return;                                   // 처리됨
    const item = { row: i + 2, time: String(r[0]), id: String(r[1]), name: String(r[2]), type: String(r[3]), desc: String(r[4]), approved: r[7] === true };
    if (item.type === 'photo' && r[6]) {
      try { const b = DriveApp.getFileById(r[6]).getBlob(); item.img = 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()); } catch (e) { item.img = ''; }
    }
    list.push(item);
  });
  return { ok: true, list: list.slice(-40) };
}
/** body.rows: 처리할 행 번호들, body.action: 'approve' | 'reject' */
function approve_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const rowsWanted = (Array.isArray(body.rows) ? body.rows : []).map(Number).filter(x => x >= 2);
  const reject = body.decision === 'reject';
  if (!rowsWanted.length) return fail_('no_rows', '처리할 항목이 없어요');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요');
  try {
    const sh = sheet_(SHEETS.approvals, APPROVAL_HEADER); const n = sh.getLastRow();
    const byStudent = {};
    rowsWanted.forEach(row => {
      if (row > n) return;
      const r = sh.getRange(row, 1, 1, APPROVAL_HEADER.length).getValues()[0];
      if (r[8] === true) return;
      if (reject) {
        sh.getRange(row, 8, 1, 2).setValues([[false, true]]);
        (byStudent[String(r[1])] = byStudent[String(r[1])] || []).push({ reject: true, type: String(r[3]), desc: String(r[4]), fileId: String(r[6] || '') });
      } else {
        sh.getRange(row, 8).setValue(true);                      // 승인 체크 → applyApprovalsFor_ 가 반영하고 처리됨 표시
        byStudent[String(r[1])] = byStudent[String(r[1])] || [];
      }
    });
    let done = 0;
    Object.keys(byStudent).forEach(id => {
      const sacc = account_(id); if (!sacc) return;
      const st = loadState_(sacc, false);
      let changed = applyApprovalsFor_(sacc, st);
      byStudent[id].forEach(x => {                                 // 거절: 사진 제거(다시 올릴 수 있게) / 쿠폰 환불
        if (!x.reject) return;
        if (x.type === 'photo') {
          const m = /uid (\d+)/.exec(x.desc); const uid = m ? Number(m[1]) : -1;
          Object.keys(st.rooms).forEach(k => st.rooms[k].inventory.forEach(it => { if (it.uid === uid && it.id === 'photo_frame') { it.img = null; it.approved = false; changed = true; } }));
          Object.keys(st.photoMonths || {}).forEach(mo => delete st.photoMonths[mo]);
          if (x.fileId) { try { DriveApp.getFileById(x.fileId).setTrashed(true); } catch (e) { /* ignore */ } }
        } else if (x.type === 'coupon') {
          const name = x.desc.replace(/^쿠폰:\s*/, '');
          const c = st.coupons.find(y => y.name === name && y.status === 'pending');
          if (c) { c.status = 'rejected'; const cp = loadCoupons_().find(y => y.name === name); if (cp) st.coins += cp.cost; changed = true; }
        }
      });
      if (changed) saveState_(sacc, st);
      done++;
    });
    return Object.assign(approvals_(acc), { done });
  } finally { lock.releaseLock(); }
}

/* ======================= 교사 설정 (심야 잠금 · 수업 시간 꾸미기 잠금 · 이벤트 · 가입 코드) ======================= */
/* ---- 교사 정의 가구 (아이템 시트) ---- */
const ITEM_HEADER = ['아이템ID', '이름', '이모지', '모양(기존 가구ID)', '희귀도(common/rare/epic)', '가격(비우면 희귀도 기본가)', '상점 판매', '상자 드롭', '사용'];
SHEETS.items = '아이템';
function loadItems_() {
  const c = cache_().get('items'); if (c) return JSON.parse(c);
  const sh = sheet_(SHEETS.items, ITEM_HEADER); const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, ITEM_HEADER.length).getValues() : [];
  const list = rows.filter(r => r[0] && r[1]).map(r => ({ id: cellStr_(r[0]), name: cellStr_(r[1]), emoji: cellStr_(r[2]), shape: cellStr_(r[3]), rarity: cellStr_(r[4]) || 'common',
    cost: Number(r[5]) || 0, pool: r[7] === true ? 'box' : 'shop', sell: r[6] !== false, enabled: r[8] !== false }));
  cache_().put('items', JSON.stringify(list), 300);
  return list;
}
function applyItems_() { applyCustomItems(loadItems_().map(x => Object.assign({}, x, { enabled: x.enabled && (x.sell || x.pool === 'box'), pool: x.sell ? x.pool : (x.pool === 'box' ? 'box' : 'none') }))); }
function saveItems_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const list = (Array.isArray(body.items) ? body.items : []).map(x => ({
    id: String(x.id || '').trim().replace(/[^A-Za-z0-9_]/g, '') || ('ci' + Date.now().toString(36)), name: String(x.name || '').trim().slice(0, 20), emoji: String(x.emoji || '').trim().slice(0, 4),
    shape: ITEMS[x.shape] && !ITEMS[x.shape].custom ? String(x.shape) : 'chair', rarity: RARITY[x.rarity] ? x.rarity : 'common', cost: Math.max(0, Math.min(100000, Number(x.cost) || 0)),
    pool: x.pool === 'box' ? 'box' : 'shop', sell: x.sell !== false, enabled: x.enabled !== false,
  })).filter(x => x.name);
  if (list.length > 40) return fail_('too_many', '가구는 40개까지예요');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요');
  try {
    const sh = sheet_(SHEETS.items, ITEM_HEADER);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    if (list.length) {
      sh.getRange(2, 1, list.length, 5).setNumberFormat('@');
      sh.getRange(2, 1, list.length, ITEM_HEADER.length).setValues(list.map(x => [x.id, x.name, x.emoji, x.shape, x.rarity, x.cost || '', x.sell, x.pool === 'box', x.enabled]));
      sh.getRange(2, 7, list.length, 3).insertCheckboxes();
      list.forEach((x, i) => sh.getRange(i + 2, 7, 1, 3).setValues([[x.sell, x.pool === 'box', x.enabled]]));
    }
    cache_().remove('items');
  } finally { lock.releaseLock(); }
  return { ok: true, items: loadItems_() };
}

/* ---- 가격·보상 (교사가 앱에서 설정) ---- */
const PRICE_KEYS = ['common', 'rare', 'epic', 'recolor', 'restyle', 'wallpaper', 'photoFrame', 'conceptCoin', 'quizCoin', 'passCoin', 'firstTryBonus', 'monsterBonus', 'stickerCoin'];
function defaultPricing_() {
  const sp = CONFIG.shopPrice || { common: 80, rare: 160, epic: 320 }, rw = CONFIG.rewards || {};
  return { common: sp.common, rare: sp.rare, epic: sp.epic, recolor: CONFIG.recolorCost, restyle: CONFIG.restyleCost, wallpaper: CONFIG.wallpaperCost, photoFrame: ITEMS.photo_frame.cost,
    conceptCoin: rw.conceptCoin, quizCoin: rw.quizCoin, passCoin: rw.passCoin, firstTryBonus: rw.firstTryBonus, monsterBonus: rw.monsterBonus, stickerCoin: (CONFIG.sticker || {}).coin };
}
let pricingDefaults_ = null;
function pricing_() {
  if (!pricingDefaults_) pricingDefaults_ = defaultPricing_();
  let saved = {}; try { saved = JSON.parse(props_().getProperty('PRICES') || '{}'); } catch (e) { saved = {}; }
  const out = {}; PRICE_KEYS.forEach(k => { const v = Number(saved[k]); out[k] = (saved[k] !== undefined && !isNaN(v) && v >= 0) ? v : pricingDefaults_[k]; });
  return out;
}
/** CONFIG/ITEMS 에 반영 (엔진이 CONFIG 를 읽으므로 요청마다 적용) */
function applyPricing_(p) {
  CONFIG.shopPrice = { common: p.common, rare: p.rare, epic: p.epic };
  CONFIG.recolorCost = p.recolor; CONFIG.restyleCost = p.restyle; CONFIG.wallpaperCost = p.wallpaper; ITEMS.photo_frame.cost = p.photoFrame;
  CONFIG.rewards = Object.assign({}, CONFIG.rewards, { conceptCoin: p.conceptCoin, quizCoin: p.quizCoin, passCoin: p.passCoin, firstTryBonus: p.firstTryBonus, monsterBonus: p.monsterBonus });
  CONFIG.sticker = Object.assign({}, CONFIG.sticker, { coin: p.stickerCoin });
}
/** 학생 앱에도 내려가는 공개 설정 */
function publicSettings_() {
  const p = props_(); let cl = null;
  try { cl = JSON.parse(p.getProperty('CLASS_LOCK') || 'null'); } catch (e) { cl = null; }
  return { nightLockOff: p.getProperty('NIGHT_LOCK_OFF') === 'true', classLock: cl || { enabled: !!CONFIG.classLock.enabled, start: CONFIG.classLock.start, end: CONFIG.classLock.end }, prices: pricing_(), itemPrices: itemPrices_() };
}
function getSettings_(acc) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const p = props_();
  return { ok: true, settings: Object.assign(publicSettings_(), { eventForce: p.getProperty('EVENT_FORCE') === 'true', joinCode: p.getProperty('JOIN_CODE') || '' }) };
}
function saveSettings_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const s = body.settings || {}; const p = props_();
  if ('nightLockOff' in s) p.setProperty('NIGHT_LOCK_OFF', s.nightLockOff ? 'true' : 'false');
  if ('eventForce' in s) p.setProperty('EVENT_FORCE', s.eventForce ? 'true' : 'false');
  if ('joinCode' in s) { const v = String(s.joinCode || '').trim(); if (v) p.setProperty('JOIN_CODE', v); else p.deleteProperty('JOIN_CODE'); }
  if (s.prices && typeof s.prices === 'object') {
    const cur = pricing_(); PRICE_KEYS.forEach(k => { const v = Number(s.prices[k]); if (s.prices[k] !== undefined && s.prices[k] !== '' && !isNaN(v) && v >= 0 && v <= 100000) cur[k] = Math.round(v); });
    p.setProperty('PRICES', JSON.stringify(cur));
  }
  if (s.classLock && typeof s.classLock === 'object') {
    const cl = { enabled: !!s.classLock.enabled, start: Math.min(23, Math.max(0, Number(s.classLock.start) || 0)), end: Math.min(24, Math.max(0, Number(s.classLock.end) || 0)) };
    p.setProperty('CLASS_LOCK', JSON.stringify(cl));
  }
  return getSettings_(acc);
}
const FOLDERS = { data: '학생데이터', photos: '승인대기사진' };
const ACC_HEADER = ['학번', '이름', '비밀번호해시', '솔트', '파일ID', '가입일', '최근접속', '공개설정', '초기화'];
const ACC = { id: 0, name: 1, hash: 2, salt: 3, fileId: 4, created: 5, last: 6, privacy: 7, reset: 8 };
const UNIT_HEADER = ['단원ID', '과목', '단원명', '성취기준', '교과서 발췌(복사 차단용)', '핵심 개념 (한 줄에 하나: 용어 | 별칭1, 별칭2 | 발판 힌트)', '오개념 (한 줄에 하나: 정규식 => 힌트)', '문항 (한 줄에 하나: 객관식 | 질문 | 보기1;보기2;보기3;보기4 | 정답번호(1부터) | 힌트  또는  단답형 | 질문 | 정답1;정답2 | 힌트)', '사용'];
const APPROVAL_HEADER = ['시각', '학번', '이름', '유형', '내용', '사진 링크', '파일ID', '승인', '처리됨'];
const SOCIAL_HEADER = ['시각', '유형', '보낸 학번', '보낸 이름', '받는 학번', '키', '상태', '만료(ms)'];
const TEACHER_HEADER = ['이메일', '이름', '승인', '등록일'];
const NIGHT_LOCK = { start: 22, end: 7 };
const TOKEN_DAYS = 30;
const SERVER_VERSION = 4;   // 앱이 서버 버전을 확인해 재배포 필요 여부를 안내함 (teacherLogin 8자리 코드 = 3)

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
    const f = subfolder_(FOLDERS.data).createFile('교사_' + e + '.json', JSON.stringify(Engine.newState({ id: 'T:' + e, name: name + ' 선생님' }, todayKey_())), MimeType.PLAIN_TEXT);
    fileId = f.getId(); props_().setProperty(key, fileId);
  }
  return { id: 'T:' + e, row: 0, name: name + ' 선생님', fileId, privacy: 'private', teacher: true };
}
/** 교사 접속 코드(시트 메뉴 ⑧에서 발급한 8자리 코드)로 앱 로그인 — 시간 제한 없음 */
/* ---- 교사 이메일+비밀번호 (교사 시트 5·6열: 비밀번호해시, 솔트) ---- */
function teacherRow_(email) {
  const e = String(email || '').trim().toLowerCase(); if (!e) return null;
  const sh = sheet_(SHEETS.teachers, TEACHER_HEADER); const n = sh.getLastRow();
  if (sh.getLastColumn() < 6) sh.getRange(1, 5, 1, 2).setValues([['비밀번호해시', '솔트']]);
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, 6).getValues() : [];
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0]).trim().toLowerCase() === e) return { row: i + 2, data: rows[i], sheet: sh };
  return null;
}
function teacherSetPassword_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const pw = String(body.password || ''); if (pw.length < 6 || pw.length > 40) return fail_('bad_pw', '비밀번호는 6자 이상이에요');
  const email = acc.id.slice(2); let t = teacherRow_(email);
  if (!t) {   // 관리자(시트 소유자)처럼 교사 시트에 없는 계정은 행을 만들어 준다
    const sh = sheet_(SHEETS.teachers, TEACHER_HEADER); sh.appendRow([email, acc.name.replace(/ 선생님$/, ''), true, todayKey_()]); t = teacherRow_(email);
  }
  const salt = Utilities.getUuid();
  t.sheet.getRange(t.row, 5, 1, 2).setValues([[hash_(salt, pw), salt]]);
  props_().setProperty('TPW_' + email, pw);   // 관리자가 앱 교사 탭에서 확인할 수 있게 보관
  return { ok: true };
}
function teacherEmailLogin_(body) {
  const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !pw) return fail_('bad', '이메일과 비밀번호를 입력해 주세요');
  const failKey = 'tfail_' + email;
  if (Number(cache_().get(failKey) || 0) >= 10) return fail_('locked', '여러 번 틀려 10분 동안 잠겼어요');
  const t = teacherRow_(email);
  if (!t || t.data[2] !== true) return fail_('not_teacher', '승인된 교사 이메일이 아니에요. 관리자에게 등록을 요청하세요');
  if (!t.data[4]) return fail_('no_pw', '아직 비밀번호가 없어요. 접속 코드로 들어간 뒤 교사 탭에서 비밀번호를 정하세요');
  if (hash_(String(t.data[5]), pw) !== String(t.data[4])) { cache_().put(failKey, String(Number(cache_().get(failKey) || 0) + 1), 600); return fail_('bad_login', '이메일 또는 비밀번호가 맞지 않아요'); }
  cache_().remove(failKey);
  const acc = account_('T:' + email); if (!acc) return fail_('not_teacher', '승인된 교사가 아니에요');
  return teacherSession_(acc);
}
function teacherLogin_(body) {
  if (body.email !== undefined && !body.code) return teacherEmailLogin_(body);   // 두 번째부터: 이메일 + 비밀번호
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const raw = code && props_().getProperty('TCODE_' + code);
  let info = null; try { info = raw ? JSON.parse(raw) : null; } catch (e) { info = null; }
  if (!info || info.exp < Date.now()) return fail_('bad_code', code.length === 8 ? '교사 접속 코드가 맞지 않거나 만료됐어요. 시트 메뉴 ⑧에서 다시 발급해 보세요' : '교사 접속 코드는 8자리예요 (예: AB12-CD34). 시트 메뉴 ⑧에서 발급하세요');
  const acc = account_('T:' + info.email); if (!acc) return fail_('not_teacher', '승인된 교사가 아니에요. 관리자에게 등록을 요청하세요');
  // 처음 등록: 코드 + 이메일 + 비밀번호 → 이메일이 코드의 계정과 같아야 하고, 비밀번호를 저장해 둔다
  const email = String(body.email || '').trim().toLowerCase();
  if (email && email !== String(info.email).toLowerCase()) return fail_('email_mismatch', '이 코드는 ' + info.email + ' 계정의 코드예요. 그 이메일을 넣어 주세요');
  let pwSet = false;
  if (body.password !== undefined) { const r = teacherSetPassword_(acc, body); if (!r.ok) return r; pwSet = true; }
  return Object.assign(teacherSession_(acc), { pwSet });
}
function teacherSession_(acc) {
  return { ok: true, token: makeToken_(acc.id), id: acc.id, name: acc.name, teacher: true, admin: isAdminAcc_(acc), state: loadState_(acc, false), units: publicUnits_(loadUnits_()), coupons: loadCoupons_(), events: loadEvents_(), settings: publicSettings_(), items: loadItems_(), inbox: { knocks: [], stickers: [] } };
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
    const old = findAccount_(id);
    const sh = sheet_(SHEETS.accounts, ACC_HEADER);
    let at = 0, archived = null;
    if (old) {
      const oldName = String(old.data[ACC.name] || '').trim();
      const oldYear = schoolYear_(old.data[ACC.created]), nowYear = schoolYear_(today);
      if (oldName === name) return fail_('exists', '이미 만들어진 학번이에요. 비밀번호를 잊었으면 선생님께 초기화를 요청하세요');
      if (oldYear >= nowYear) return fail_('exists', '이 학번은 올해 "' + oldName.slice(0, 1) + '○○" 이름으로 이미 가입되어 있어요. 학번을 확인하거나 선생님께 말씀하세요');
      // 학년이 바뀌어 같은 학번을 다른 학생이 쓰게 됨 → 지난 학년도 자료는 이름을 바꿔 보관하고 새 방으로 시작
      try { const f = DriveApp.getFileById(old.data[ACC.fileId]); f.setName(id + '_' + oldName + '_' + oldYear + '학년도.json'); } catch (e) { /* 파일이 없으면 그냥 새로 시작 */ }
      try { sheet_(SHEETS.past, PAST_HEADER).appendRow([id, oldName, old.data[ACC.hash], old.data[ACC.salt], old.data[ACC.fileId], oldYear, today]); } catch (e) { /* 보관 실패는 무시 */ }   // 본인이 새 학번으로 지난 자료를 볼 때 비밀번호 확인용
      at = old.row; archived = { name: oldName, year: oldYear };
    }
    const salt = Utilities.getUuid();
    const state = Engine.newState({ id, name }, today);
    const file = subfolder_(FOLDERS.data).createFile(id + '.json', JSON.stringify(state), MimeType.PLAIN_TEXT);
    if (!at) {
      const rows = accountRows_();
      at = rows.length + 2;
      for (let i = 0; i < rows.length; i++) { if (idNum_(id) < idNum_(rows[i][ACC.id])) { at = i + 2; break; } }
      sh.insertRowBefore(at);
    }
    sh.getRange(at, 1, 1, ACC_HEADER.length).setValues([[id, name, hash_(salt, pw), salt, file.getId(), today, today, 'knock', false]]);
    sh.getRange(at, 1).setNumberFormat('@');
    uncache_(id);
    if (archived) try { sheet_(SHEETS.accounts, ACC_HEADER).getRange(at, ACC_HEADER.length + 1).setValue('지난 학년도(' + archived.year + ') ' + archived.name + ' 자료는 학생데이터 폴더에 보관'); } catch (e) { /* 메모 실패는 무시 */ }
    return { ok: true, token: makeToken_(id), name, state, units: publicUnits_(loadUnits_()), coupons: loadCoupons_(), events: loadEvents_(), settings: publicSettings_(), items: loadItems_(), inbox: { knocks: [], stickers: [] } };
  } finally { lock.releaseLock(); }
}
/* ======================= 교사 관리 (관리자 = 시트 소유자 · 앱 교사 탭) ======================= */
function isAdminAcc_(acc) { try { return !!acc && !!acc.teacher && String(acc.id).slice(2).toLowerCase() === ownerEmail_().toLowerCase(); } catch (e) { return false; } }
function teacherRows6_() {
  const sh = sheet_(SHEETS.teachers, TEACHER_HEADER);
  if (sh.getLastColumn() < 6) sh.getRange(1, 5, 1, 2).setValues([['비밀번호해시', '솔트']]);
  const n = sh.getLastRow();
  return { sh, rows: n > 1 ? sh.getRange(2, 1, n - 1, 6).getValues() : [], n };
}
function teacherList_(acc) {
  if (!isAdminAcc_(acc)) return fail_('forbidden', '관리자(시트 소유자)만 볼 수 있어요');
  const { rows } = teacherRows6_();
  const list = rows.filter(r => String(r[0]).trim()).map(r => ({ email: String(r[0]).trim().toLowerCase(), name: String(r[1] || ''), approved: r[2] === true,
    created: r[3] instanceof Date ? todayKey_(r[3]) : String(r[3] || ''), hasPw: !!r[4], password: props_().getProperty('TPW_' + String(r[0]).trim().toLowerCase()) || '' }));
  return { ok: true, owner: ownerEmail_().toLowerCase(), teachers: list };
}
function saveTeachers_(acc, body) {
  if (!isAdminAcc_(acc)) return fail_('forbidden', '관리자(시트 소유자)만 바꿀 수 있어요');
  const list = Array.isArray(body.teachers) ? body.teachers : [];
  const { sh, rows, n } = teacherRows6_();
  const seen = {}, out = [];
  for (const t of list) {
    const email = String(t.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail_('bad_email', '이메일 형식을 확인해 주세요: ' + email);
    if (seen[email]) continue; seen[email] = 1;
    const old = rows.find(r => String(r[0]).trim().toLowerCase() === email);
    let hash = old ? old[4] : '', salt = old ? old[5] : '';
    const pw = String(t.initPassword || '');
    if (pw) { if (pw.length < 6 || pw.length > 40) return fail_('bad_pw', email + ': 비밀번호는 6자 이상이에요'); salt = Utilities.getUuid(); hash = hash_(salt, pw); props_().setProperty('TPW_' + email, pw); }
    const approved = t.approved === true;
    out.push([email, String(t.name || '').trim().slice(0, 20), approved, old && old[3] ? old[3] : todayKey_(), hash, salt]);
    if (approved && !(old && old[2] === true)) { try { folder_().addEditor(email); } catch (e) { /* 폴더 공유 실패는 무시 (수동 공유 가능) */ } }
  }
  rows.forEach(r => { const e = String(r[0]).trim().toLowerCase(); if (e && !seen[e]) props_().deleteProperty('TPW_' + e); });   // 목록에서 빠진 교사의 보관 비밀번호 삭제
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요');
  try {
    if (n > 1) sh.getRange(2, 1, n - 1, 6).clearContent();
    if (out.length) { sh.getRange(2, 1, out.length, 6).setValues(out); sh.getRange(2, 3, out.length, 1).insertCheckboxes(); sh.getRange(2, 1, out.length, 2).setNumberFormat('@'); }
  } finally { lock.releaseLock(); }
  return teacherList_(acc);
}

/* ======================= 지난 학번 자료 (학생 본인이 지난 학번+비밀번호로 연결) ======================= */
const PAST_HEADER = ['학번', '이름', '비밀번호해시', '솔트', '파일ID', '학년도', '보관일'];
function linkPast_(acc, body, today) {
  if (acc.teacher) return fail_('forbidden', '교사 계정에는 지난 학번이 없어요');
  const pid = String(body.id || '').trim(), pw = String(body.password || '');
  if (!/^\d{3,10}$/.test(pid) || !pw) return fail_('bad', '지난 학번과 비밀번호를 입력해 주세요');
  if (pid === acc.id) return fail_('same', '지금 쓰고 있는 학번이에요');
  const failKey = 'pfail_' + acc.id;
  if (Number(cache_().get(failKey) || 0) >= 10) return fail_('locked', '여러 번 틀려 10분 동안 잠겼어요');
  let found = null;
  const live = findAccount_(pid);   // 아직 다른 학생이 쓰지 않는 지난 학번
  if (live && hash_(live.data[ACC.salt], pw) === live.data[ACC.hash]) found = { id: pid, name: String(live.data[ACC.name]), fileId: String(live.data[ACC.fileId]), year: schoolYear_(live.data[ACC.created]) };
  if (!found) {                      // 새 학년도에 다른 학생이 이어받아 보관된 계정
    const sh = sheet_(SHEETS.past, PAST_HEADER); const n = sh.getLastRow();
    const rows = n > 1 ? sh.getRange(2, 1, n - 1, PAST_HEADER.length).getValues() : [];
    for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (String(r[0]) === pid && hash_(String(r[3]), pw) === String(r[2])) { found = { id: pid, name: String(r[1]), fileId: String(r[4]), year: Number(r[5]) || 0 }; break; } }
  }
  if (!found) { cache_().put(failKey, String(Number(cache_().get(failKey) || 0) + 1), 600); return fail_('bad_login', '지난 학번 또는 그때 비밀번호가 맞지 않아요'); }
  cache_().remove(failKey);
  const st = loadState_(acc, false);
  st.pastLinks = (st.pastLinks || []).filter(p => p.fileId !== found.fileId);
  st.pastLinks.push({ id: found.id, name: found.name, fileId: found.fileId, year: found.year, linkedAt: today });
  saveState_(acc, st);
  return { ok: true, pastLinks: st.pastLinks };
}
function pastView_(acc, body) {
  const st = loadState_(acc, false);
  const link = (st.pastLinks || []).find(p => p.id === String(body.id || ''));
  if (!link) return fail_('no_link', '먼저 지난 학번을 연결해 주세요');
  let past;
  try { past = Engine.migrate(JSON.parse(DriveApp.getFileById(link.fileId).getBlob().getDataAsString('UTF-8')), loadUnits_()); } catch (e) { return fail_('no_file', '지난 자료 파일을 찾을 수 없어요. 선생님께 문의하세요'); }
  const view = Engine.publicView(past);   // 본인 자료라 점수·전체 기록도 함께
  view.records = (past.records || []).map(r => ({ date: r.date, topicId: r.topicId, unitId: r.unitId, pass: !!r.pass, score: r.score, summary: r.summary, opened: (r.opened || []).length, quiz: r.quiz }));
  view.coins = past.coins;
  view.frames = []; Object.keys(past.rooms).forEach(k => past.rooms[k].inventory.forEach(i => { if (i.id === 'concept_frame' && i.img) view.frames.push({ unitId: i.unitId || k, img: i.img }); }));
  return { ok: true, view, link: { id: link.id, name: link.name, year: link.year } };
}
/** 학년도: 3월~다음해 2월 */
function schoolYear_(d) { const s = d instanceof Date ? Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd') : String(d || ''); const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)); if (!y) return 0; return m >= 3 ? y : y - 1; }
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
  return { ok: true, token: makeToken_(id), name: acc.name, state, units: publicUnits_(loadUnits_()), coupons: loadCoupons_(), events: loadEvents_(), settings: publicSettings_(), items: loadItems_(), inbox: inbox_(acc), mustChange: a.data[ACC.reset] === true };
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
  st.settings.eventForce = props_().getProperty('EVENT_FORCE') === 'true';   // 이벤트 강제는 교사 설정(전체 공통)
  if (acc.teacher) st.coins = 999999;                                        // 교사는 코인 무제한
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
  // 문항 시트에 행이 있는 성취기준은 그 행들을 문항으로 사용 (교사가 수정·추가·삭제한 결과)
  const qmap = questionMap_();
  units.forEach(u => { if (qmap[u.id] && qmap[u.id].length) u.questions = qmap[u.id]; });
  cache_().put('units', JSON.stringify(units), 300);
  return units.map(reviveUnit_);
}
/** 문항 시트 → { 성취기준ID: [question...] } ('사용' 꺼진 행 제외) */
function questionMap_() {
  const sh = sheet_(SHEETS.questions, QUESTION_HEADER); const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, QUESTION_HEADER.length).getValues() : [];
  const map = {};
  rows.forEach(r => {
    const q = parseQuestionRow_(r); if (!q) return;
    (map[String(r[0]).trim()] = map[String(r[0]).trim()] || []).push(q);
  });
  return map;
}
/** 시트 셀 값 → 문자열. 시트가 "1:16" 같은 값을 시간(Date)으로 바꿔 둔 경우 원래 글자로 되돌림 */
function cellStr_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const h = v.getHours(), m = v.getMinutes(), s = v.getSeconds();
    if (v.getFullYear() < 1905) return h + ':' + (m < 10 ? '0' : '') + m + (s ? ':' + (s < 10 ? '0' : '') + s : '');   // 시간으로 오인된 값
    return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  }
  return String(v).trim();
}
function parseQuestionRow_(r) {
  const id = cellStr_(r[0]), type = cellStr_(r[1]), text = cellStr_(r[2]);
  if (!id || !text || r[9] === false) return null;
  if (/^객관식/.test(type)) {
    const choices = [r[3], r[4], r[5], r[6]].map(cellStr_).filter(Boolean);
    const ans = Number(r[7]) - 1;
    if (choices.length < 2 || !(ans >= 0 && ans < choices.length)) return null;
    return { type: 'mc', q: text, choices, answer: ans, hint: cellStr_(r[8]) };
  }
  if (/^단답형/.test(type)) {
    const answers = cellStr_(r[7]).split(';').map(x => x.trim()).filter(Boolean);
    if (!answers.length) return null;
    return { type: 'short', q: text, answers, hint: cellStr_(r[8]) };
  }
  return null;
}
/** 문항 행을 쓸 때 자동 변환(시간·날짜·수식)을 막기 위해 글자 칸을 텍스트 서식으로 고정 */
function textFormatQuestionRange_(sh, startRow, count) {
  sh.getRange(startRow, 1, count, 7).setNumberFormat('@');   // ID·유형·질문·보기1~4
  sh.getRange(startRow, 9, count, 1).setNumberFormat('@');   // 힌트
}
function questionToRow_(id, q) {
  return q.type === 'mc'
    ? [id, '객관식', q.q, q.choices[0] || '', q.choices[1] || '', q.choices[2] || '', q.choices[3] || '', q.answer + 1, q.hint || '', true]
    : [id, '단답형', q.q, '', '', '', '', (q.answers || []).join(';'), q.hint || '', true];
}
/** 특정 성취기준의 문항 행을 모두 교체 (교사 편집기 저장 / 예시 채우기) — 호출자가 잠금을 잡고 있어야 함 */
function replaceQuestionRows_(id, questions) {
  const sh = sheet_(SHEETS.questions, QUESTION_HEADER); const n = sh.getLastRow();
  for (let r = n; r >= 2; r--) if (String(sh.getRange(r, 1).getValue()).trim() === id) sh.deleteRow(r);
  if (questions.length) {
    const start = sh.getLastRow() + 1;
    textFormatQuestionRange_(sh, start, questions.length);
    sh.getRange(start, 1, questions.length, QUESTION_HEADER.length).setValues(questions.map(q => questionToRow_(id, q)));
    sh.getRange(start, 10, questions.length, 1).insertCheckboxes();
  }
  cache_().remove('units');
}
/** 교사 편집기: 문항 목록(정답 포함) */
function questionsFor_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const u = loadUnits_().find(x => x.id === body.topicId); if (!u) return fail_('no_unit', '성취기준을 찾을 수 없어요');
  return { ok: true, topicId: u.id, questions: u.questions, source: questionMap_()[u.id] ? 'sheet' : 'unit' };
}
/** 교사 편집기: 문항 저장(수정·추가·삭제 결과 전체를 받아 문항 시트에 반영) */
function saveQuestions_(acc, body) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const id = String(body.topicId || '').trim();
  if (!loadUnits_().some(x => x.id === id)) return fail_('no_unit', '성취기준을 찾을 수 없어요');
  const list = Array.isArray(body.questions) ? body.questions : [];
  const clean = [];
  for (const q of list) {
    const text = String(q.q || '').trim(); if (!text) continue;
    if (q.type === 'mc') {
      const choices = (q.choices || []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 4);
      const ans = Number(q.answer);
      if (choices.length < 2 || !(ans >= 0 && ans < choices.length)) return fail_('bad_q', '객관식은 보기 2개 이상과 정답 번호가 필요해요: ' + text.slice(0, 20));
      clean.push({ type: 'mc', q: text, choices, answer: ans, hint: String(q.hint || '').trim() });
    } else {
      const answers = (q.answers || []).map(x => String(x || '').trim()).filter(Boolean);
      if (!answers.length) return fail_('bad_q', '단답형은 정답이 1개 이상 필요해요: ' + text.slice(0, 20));
      clean.push({ type: 'short', q: text, answers, hint: String(q.hint || '').trim() });
    }
  }
  if (clean.length > 10) return fail_('too_many', '문항은 성취기준당 10개까지예요');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', '지금 접속이 많아요. 잠시 후 다시 시도해 주세요');
  try { replaceQuestionRows_(id, clean); } finally { lock.releaseLock(); }
  return { ok: true, count: clean.length };
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
          let it = null; Object.keys(state.rooms).forEach(k => { const f = state.rooms[k].inventory.find(i => i.uid === p.uid); if (f) it = f; });
          if (!it || !it.img) continue;
          const blob = Utilities.newBlob(Utilities.base64Decode(it.img.split(',')[1]), 'image/jpeg', acc.id + '_' + p.uid + '.jpg');
          const f = subfolder_(FOLDERS.photos).createFile(blob);
          link = f.getUrl(); fileId = f.getId(); desc = '사진 액자 (uid ' + p.uid + ')';
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
  const tst = loadState_(target, false);
  const view = Engine.publicView(tst);
  if (acc.teacher) {   // 교사에게는 학습 상황(점수·시도·개념·괴물)도 함께
    view.records = tst.records; view.coins = tst.coins;
    view.monsterRooms = Object.keys(tst.rooms).filter(k => tst.rooms[k].monster);
  }
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
/* ---- 접속 중 학생 (교사 내 방에 표시): 학생 요청마다 캐시에 시각 기록, 최근 5분 이내를 접속 중으로 봄 ---- */
function touchOnline_(acc, where) {
  try {
    const c = cache_(); const now = Date.now();
    const map = JSON.parse(c.get('online') || '{}');
    map[acc.id] = { t: now, where: String(where || '').slice(0, 40) };
    Object.keys(map).forEach(k => { const t = typeof map[k] === 'number' ? map[k] : map[k].t; if (now - t > 600000) delete map[k]; });
    c.put('online', JSON.stringify(map), 1200);
  } catch (e) { /* ignore */ }
}
function online_(acc) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const now = Date.now(); const map = JSON.parse(cache_().get('online') || '{}');
  const names = {}; accountRows_().forEach(r => names[String(r[ACC.id])] = r[ACC.name]);
  const ent = id => (typeof map[id] === 'number' ? { t: map[id], where: '' } : map[id]);
  const students = Object.keys(map).filter(id => now - ent(id).t < 300000 && names[id]).sort().map(id => ({ id, name: names[id], seen: ent(id).t, where: ent(id).where || '' }));
  return { ok: true, students };
}
/* ---- 전체 학생 학습 정리 (교사 서재) ---- */
function allSummaries_(acc) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const c = cache_().get('allsum'); if (c) return { ok: true, rows: JSON.parse(c), cached: true };
  const rows = [];
  accountRows_().forEach(r => {
    try {
      const st = JSON.parse(DriveApp.getFileById(r[ACC.fileId]).getBlob().getDataAsString('UTF-8'));
      (st.records || []).forEach(x => rows.push({ id: String(r[ACC.id]), name: r[ACC.name], date: x.date, topicId: x.topicId || x.unitId, unitId: x.unitId, pass: !!x.pass, score: x.score || 0,
        opened: (x.opened || x.hits || []).length, attempts: x.attempts || 0, quiz: x.quiz ? x.quiz.correct + '/' + x.quiz.total : '', summary: String(x.summary || '').slice(0, 600) }));
    } catch (e) { /* 파일 없음 등 */ }
  });
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const out = rows.slice(0, 1000);
  try { cache_().put('allsum', JSON.stringify(out), 120); } catch (e) { /* 100KB 초과 시 캐시 생략 */ }
  return { ok: true, rows: out };
}
/* ---- 단원별 활동 시작 학생 수 (기록이 하나라도 있는 학생) — allSummaries 캐시 재사용 ---- */
function unitStats_(acc) {
  if (!acc.teacher) return fail_('forbidden', '교사만 사용할 수 있어요');
  const rows = allSummaries_(acc).rows || []; const sets = {};
  rows.forEach(r => { (sets[r.unitId] = sets[r.unitId] || {})[r.id] = true; });
  const stats = {}; Object.keys(sets).forEach(k => stats[k] = Object.keys(sets[k]).length);
  return { ok: true, stats, students: new Set(rows.map(r => r.id)).size };
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
  return json_({ ok: true, app: 'studyroom', version: SERVER_VERSION, serverTime: now.toISOString(), locked: nightLocked_(now) });
}
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_(fail_('bad_json')); }
  const now = kstNow_(), today = todayKey_(now);
  applyPricing_(pricing_());                                   // 교사가 정한 가격·보상 반영
  applyItems_();                                               // 교사 정의 가구 병합
  applyItemPrices_();                                          // 가구별 개별 가격
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
    if (!acc.teacher) touchOnline_(acc, body.where);
    switch (a) {
      case 'online': return json_(online_(acc));                         // 교사 전용
      case 'unitStats': return json_(unitStats_(acc));                   // 교사 전용
      case 'seedTest': return json_(seedTest_(acc, body, today));          // 교사 전용 (테스트 자료)
      case 'grantCoins': return json_(grantCoins_(acc, body));           // 교사 전용 (코인 일괄 지급)
      case 'genQuestions': return json_(genQuestions_(acc, body));       // 교사 전용 (문항 자동 생성 초안)
      case 'saveItemPrices': return json_(saveItemPrices_(acc, body));   // 교사 전용 (가구별 가격)
      case 'allSummaries': return json_(allSummaries_(acc));             // 교사 전용
      case 'load': return json_({ ok: true, state: loadState_(acc, true), units: publicUnits_(loadUnits_()), coupons: loadCoupons_(), events: loadEvents_(), settings: publicSettings_(), items: loadItems_(), inbox: inbox_(acc) });
      case 'cmd': return json_(command_(acc, body.cmd, today));
      case 'grade': {
        const u = loadUnits_().find(x => x.id === (body.topicId || body.unitId)); if (!u) return json_(fail_('no_unit', '성취기준을 찾을 수 없어요'));
        return json_({ ok: true, result: Engine.grade(u, body.answers || {}) });
      }
      case 'changePassword': return json_(changePassword_(acc, body));
      case 'teacherSetPassword': return json_(teacherSetPassword_(acc, body));   // 교사: 이메일 로그인용 비밀번호
      case 'teachers': return json_(teacherList_(acc));                 // 관리자 전용
      case 'saveTeachers': return json_(saveTeachers_(acc, body));       // 관리자 전용
      case 'linkPast': return json_(linkPast_(acc, body, today));          // 학생: 지난 학번 연결
      case 'pastView': return json_(pastView_(acc, body));                // 학생: 지난 학번 자료 보기
      case 'classmates': return json_(classmates_(acc));
      case 'knock': return json_(knock_(acc, body));
      case 'allow': return json_(allow_(acc, body));
      case 'visit': return json_(visit_(acc, body));
      case 'sticker': return json_(sticker_(acc, body, today));
      case 'inbox': return json_({ ok: true, inbox: inbox_(acc), settings: publicSettings_() });   // 1분 폴링으로 잠금 설정도 갱신
      case 'questions': return json_(questionsFor_(acc, body));          // 교사 전용
      case 'saveQuestions': return json_(saveQuestions_(acc, body));     // 교사 전용
      case 'coupons': return json_({ ok: true, coupons: loadCoupons_() });
      case 'items': return json_({ ok: true, items: loadItems_() });
      case 'saveItems': return json_(saveItems_(acc, body));             // 교사 전용
      case 'approvals': return json_(approvals_(acc));                   // 교사 전용
      case 'events': return json_({ ok: true, events: loadEvents_() });
      case 'saveEvents': return json_(saveEvents_(acc, body));           // 교사 전용
      case 'approve': return json_(approve_(acc, body));                 // 교사 전용
      case 'saveCoupons': return json_(saveCoupons_(acc, body));         // 교사 전용
      case 'getSettings': return json_(getSettings_(acc));               // 교사 전용
      case 'saveSettings': return json_(saveSettings_(acc, body));       // 교사 전용
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
  const r = Engine.apply(state, cmd, { topics: units, units, coupons: loadCoupons_(), events: loadEvents_(), today, rng: Math.random });
  if (!r.ok) return fail_('rejected', r.error);
  if (cmd.type === 'settings' && acc.row > 0) { sheet_(SHEETS.accounts, ACC_HEADER).getRange(acc.row, ACC.privacy + 1).setValue(state.settings.privacy); uncache_(acc.id); }
  flushPendingApprovals_(acc, state);
  if (acc.teacher) state.coins = 999999;   // 교사는 코인 무제한
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
  sheet_(SHEETS.coupons, COUPON_HEADER); loadCoupons_(); sheet_(SHEETS.events, EVENT_HEADER); loadEvents_(); sheet_(SHEETS.items, ITEM_HEADER);
  const qs = sheet_(SHEETS.questions, QUESTION_HEADER);
  qs.getRange('B2:B1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['객관식', '단답형'], true).setAllowInvalid(false).build());
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
  // 문항 시트: 아직 행이 없는 성취기준만 채움 (교사가 고친 문항은 보존)
  sheet_(SHEETS.coupons, COUPON_HEADER); loadCoupons_(); sheet_(SHEETS.events, EVENT_HEADER); loadEvents_(); sheet_(SHEETS.items, ITEM_HEADER);
  const qs = sheet_(SHEETS.questions, QUESTION_HEADER);
  qs.getRange('B2:B1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['객관식', '단답형'], true).setAllowInvalid(false).build());
  const have = questionMap_(); const qrows = [];
  UNITS.forEach(u => { if (!have[u.id]) u.questions.forEach(q => qrows.push(questionToRow_(u.id, q))); });
  if (qrows.length) {
    const start = qs.getLastRow() + 1;
    textFormatQuestionRange_(qs, start, qrows.length);
    qs.getRange(start, 1, qrows.length, QUESTION_HEADER.length).setValues(qrows);
    qs.getRange(start, 10, qrows.length, 1).insertCheckboxes();
  }
  // 이미 들어 있는 행도 텍스트 서식으로 고정 + 시간으로 바뀐 값 복구
  if (qs.getLastRow() > 1) {
    const n = qs.getLastRow() - 1; const rng = qs.getRange(2, 1, n, 9); const vals = rng.getValues();
    const fixed = vals.map(r => r.map((v, j) => (j === 7 ? v : cellStr_(v))));
    textFormatQuestionRange_(qs, 2, n); rng.setValues(fixed);
  }
  qs.setColumnWidths(3, 1, 320); qs.setFrozenRows(1);
  cache_().remove('units');
  alert_('단원 시트 갱신: 추가 ' + added.length + '개, 덮어쓰기 ' + updated + '개' + (removed ? ', 예전 예시 삭제 ' + removed + '개' : '') + '.\n문항 시트: 문항 ' + qrows.length + '개 추가 (이미 있는 성취기준의 문항은 그대로 둠)\n\n형성평가 문항은 "문항" 시트에서 행 단위로 수정·추가·삭제하거나, 앱에 교사로 접속해 교사 탭의 문항 관리에서 고칠 수 있어요. (학생 화면에는 5분 이내 반영)');
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
