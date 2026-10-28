/* =====================================================================
 *  engine.js — 공용 게임 로직 (브라우저 로컬 모드 + GAS 서버 공용)
 *  상태(state)를 받아 명령(cmd)을 적용하는 순수 함수 모음.
 *  서버 모드에서는 이 파일이 서버에서 실행되어 코인·보상·판정을 결정한다.
 *  (catalog.js, judge.js 가 먼저 로드되어 있어야 함)
 *
 *  용어: topic = 성취기준 하나(문항·핵심 개념 보유), unit = 같은 단원명의 topic 묶음(= 방 하나)
 * ===================================================================== */
const Engine = (() => {
  const N = 8;
  const VERSION = 2;
  const DEFAULT_ROOM = () => ({ wall: '#f6ecdc', floor: '#d8b07c', inventory: [], monster: null });
  const R = () => Object.assign({ conceptCoin: 10, quizCoin: 10, passCoin: 30, firstTryBonus: 20, monsterBonus: 15 }, CONFIG.rewards || {});

  /* ---------- 단원 묶기 ---------- */
  function unitIdOf(t) { return t.unitId || String(t.id).replace(/_\d\d$/, ''); }
  /** 평탄한 topic 목록 → [{ id, subject, title, topics[] }] (순서 유지) */
  function groupUnits(topics) {
    const map = {}, out = [];
    (topics || []).forEach(t => {
      const uid = unitIdOf(t);
      if (!map[uid]) { map[uid] = { id: uid, subject: t.subject, title: t.title, topics: [] }; out.push(map[uid]); }
      map[uid].topics.push(t);
    });
    return out;
  }
  function topicsOf(ctx) { return ctx.topics || ctx.units || []; }

  /* ---------- 상태 생성 / 마이그레이션 (앱이 업데이트되어도 기존 데이터 보존) ---------- */
  function newState(student, today) {
    return {
      version: VERSION, student, coins: 0, uidSeq: 1,
      rooms: {},                 // unitId → { wall, floor, inventory[], monster }
      records: [],               // { date, topicId, unitId, attempts, quizRewarded, passRewarded, opened[], quiz, summary, score, pass, hits, reason, reward }
      coupons: [], conceptMaps: {}, photoMonths: {},
      settings: { privacy: 'knock', bypassLock: false, eventForce: false },
      synergyLog: {}, pendingApprovals: [], stickerLog: {},
      createdAt: today || '', updatedAt: today || '',
    };
  }
  function migrate(state, units) {
    if (!state || typeof state !== 'object') return null;
    if (!state.version || state.version < 2) {
      const first = units && units[0];                       // 묶인 단원({id}) 또는 topic({unitId}) 둘 다 허용
      const key = first ? (first.unitId || first.id) : 'home';
      const r = DEFAULT_ROOM();
      if (state.room) { r.wall = state.room.wall || r.wall; r.floor = state.room.floor || r.floor; }
      r.inventory = state.inventory || []; r.monster = state.monster || null;
      state.rooms = Object.assign({}, state.rooms || {}, { [key]: r });
      delete state.inventory; delete state.room; delete state.monster;
      state.version = 2;
    }
    const base = newState(state.student, state.createdAt);
    for (const k of Object.keys(base)) if (state[k] === undefined) state[k] = base[k];
    for (const k of Object.keys(base.settings)) if (state.settings[k] === undefined) state.settings[k] = base.settings[k];
    Object.keys(state.rooms).forEach(k => { const d = DEFAULT_ROOM(); for (const f of Object.keys(d)) if (state.rooms[k][f] === undefined) state.rooms[k][f] = d[f]; });
    // 성취기준 단위 이전 기록 보정
    state.records.forEach(r => {
      if (!r.topicId) r.topicId = r.unitId;
      if (!Array.isArray(r.opened)) r.opened = (r.hits || []).slice();
      if (r.passRewarded === undefined) r.passRewarded = !!r.rewarded;
      if (r.quizRewarded === undefined) r.quizRewarded = !!r.rewarded;
    });
    return state;
  }

  /* ---------- 헬퍼 ---------- */
  function room(state, unitId) { if (!state.rooms[unitId]) state.rooms[unitId] = DEFAULT_ROOM(); return state.rooms[unitId]; }
  function footprint(it) { const def = ITEMS[it.id]; return (it.rot || 0) % 2 ? { w: def.d, d: def.w } : { w: def.w, d: def.d }; }
  function randomFreeTile(r, rng) {
    const occ = new Set();
    r.inventory.filter(i => i.placed && !ITEMS[i.id].wall).forEach(i => {
      const f = footprint(i);
      for (let x = i.x; x < i.x + f.w; x++) for (let y = i.y; y < i.y + f.d; y++) occ.add(x + ',' + y);
    });
    const free = [];
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) if (!occ.has(x + ',' + y)) free.push({ x, y });
    return free.length ? free[Math.floor(rng() * free.length)] : { x: N - 1, y: N - 1 };
  }
  function addItem(state, unitId, id, today, extra) {
    const it = Object.assign({ uid: state.uidSeq++, id, color: 'wood', style: 'basic', placed: false, rot: 0, x: 0, y: 0, side: 'R', pos: 0, obtainedAt: today }, extra || {});
    room(state, unitId).inventory.push(it);
    return it;
  }
  /** 이벤트 목록: 서버(이벤트 시트) 또는 기본 CONFIG.event 하나 */
  function defaultEvents() { return [Object.assign({ id: 'default', force: false }, CONFIG.event)]; }
  /** 지금 진행 중인 이벤트들 (기간 안이거나 강제 활성화). 비어 있으면 이벤트 없음 */
  function activeEvents(state, today, events) {
    const list = (events && events.length) ? events : defaultEvents();
    return list.filter(e => e.force || (state && state.settings.eventForce) || (today >= e.start && today <= e.end));
  }
  function eventActive(state, today, events) { return activeEvents(state, today, events).length > 0; }
  function rollItem(state, today, rng, events) {
    const act = activeEvents(state, today, events).filter(e => (e.itemIds || []).some(id => ITEMS[id]));
    if (act.length) {
      const ev = act[Math.floor(rng() * act.length)];
      const ids = ev.itemIds.filter(id => ITEMS[id]);
      if (rng() < (ev.dropRate === undefined ? 0.35 : ev.dropRate)) return ids[Math.floor(rng() * ids.length)];
    }
    const pool = Object.keys(ITEMS).filter(k => ITEMS[k].pool === 'box');
    const total = pool.reduce((s, k) => s + RARITY[ITEMS[k].rarity].weight, 0);
    let r = rng() * total;
    for (const k of pool) { r -= RARITY[ITEMS[k].rarity].weight; if (r <= 0) return k; }
    return pool[0];
  }
  /** 단원별 진행: 통과한 성취기준 수 / 전체, 통과 기록들 */
  function unitProgress(state, topics, unitId) {
    const ts = (topics || []).filter(t => unitIdOf(t) === unitId);
    const passedIds = new Set(state.records.filter(r => r.pass && r.unitId === unitId).map(r => r.topicId));
    const passed = ts.filter(t => passedIds.has(t.id)).length;
    return { total: ts.length, passed, records: state.records.filter(r => r.pass && r.unitId === unitId) };
  }
  function monthStats(state, month) {
    const passed = state.records.filter(r => r.pass && r.date.startsWith(month));
    return { passed, days: new Set(passed.map(r => r.date)).size };
  }
  function normAns(s) { return String(s === undefined || s === null ? '' : s).replace(/\s/g, '').toLowerCase(); }

  /* ---------- 형성평가 채점 ---------- */
  function grade(topic, answers) {
    return topic.questions.map((q, i) => {
      const a = answers ? answers[i] : null;
      const ok = q.type === 'mc' ? Number(a) === q.answer : (q.answers || []).some(x => normAns(x) === normAns(a));
      return { ok, hint: ok ? '' : q.hint };
    });
  }

  /* ---------- 요약 제출 (판정 + 기록 + 부분 보상 + 먼지 괴물) ---------- */
  function submit(state, topic, answers, text, today, rng, events) {
    const rw = R();
    const unitId = unitIdOf(topic);
    const g = grade(topic, answers);
    const qs = { correct: g.filter(x => x.ok).length, total: g.length };
    const j = Judge.evaluate(text, topic);
    const res = { pass: j.pass, score: j.score, hits: j.hits, total: j.total, hint: j.hint, feedback: j.feedback, reason: j.reason };

    let rec = state.records.find(r => r.topicId === topic.id && r.date === today);
    if (!rec) {
      rec = { date: today, topicId: topic.id, unitId, attempts: 0, quizRewarded: false, passRewarded: false, opened: [], quiz: qs, summary: '', score: 0, pass: false, hits: [] };
      state.records.push(rec);
    }
    rec.attempts++; rec.summary = text; rec.score = res.score; rec.pass = res.pass || rec.pass; rec.hits = res.hits; rec.reason = res.reason; rec.quiz = qs;

    // 개념이 "열린" 개수만큼 부분 보상 (같은 날 같은 성취기준에서 새로 연 개념만)
    const newly = res.hits.filter(h => !rec.opened.includes(h));
    rec.opened = rec.opened.concat(newly);
    const bd = { concept: newly.length * rw.conceptCoin, quiz: 0, pass: 0, first: 0, monster: 0 };
    if (!rec.quizRewarded) { bd.quiz = qs.correct * rw.quizCoin; rec.quizRewarded = true; }

    const r = room(state, unitId);
    const outcome = { purified: false, itemId: null, itemUid: null, practice: false, monster: null, newlyOpened: newly, opened: rec.opened.length, total: topic.keyConcepts.length };
    if (res.pass) {
      if (r.monster) {
        outcome.purified = true; bd.monster = rw.monsterBonus;
        outcome.monsterAt = { x: r.monster.x, y: r.monster.y };
        r.monster = null;
      }
      if (!rec.passRewarded) {
        rec.passRewarded = true;
        bd.pass = rw.passCoin; if (rec.attempts === 1) bd.first = rw.firstTryBonus;
        outcome.itemId = rollItem(state, today, rng, events);
        outcome.itemUid = addItem(state, unitId, outcome.itemId, today).uid;
      } else outcome.practice = true;
    } else if (!r.monster && res.reason !== 'too_short') {
      r.monster = Object.assign(randomFreeTile(r, rng), { unitId, topicId: topic.id, since: today });
      outcome.monster = r.monster;
    }
    outcome.breakdown = bd;
    outcome.coins = bd.concept + bd.quiz + bd.pass + bd.first + bd.monster;
    state.coins += outcome.coins;
    rec.reward = { coins: (rec.reward ? rec.reward.coins : 0) + outcome.coins, itemId: outcome.itemId || (rec.reward && rec.reward.itemId) || null };
    return { res, outcome, quiz: g, record: { date: rec.date, attempts: rec.attempts, passRewarded: rec.passRewarded, opened: rec.opened } };
  }

  /* ---------- 명령 적용 ----------
   *  cmd.type: layout | restyle | wallpaper | buyFrame | buyCoupon | photo | conceptFrame | settings | submit
   *  ctx: { topics(또는 units), today, rng }
   *  반환: { ok, error?, result? }   (ok=false 이면 state 는 변경되지 않음)
   */
  function apply(state, cmd, ctx) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, error: '잘못된 요청이에요' };
    const fail = msg => ({ ok: false, error: msg });
    const spend = cost => { if (state.coins < cost) return false; state.coins -= cost; return true; };

    switch (cmd.type) {
      case 'layout': {
        if (!cmd.unitId || !Array.isArray(cmd.items)) return fail('잘못된 배치 정보예요');
        const r = room(state, cmd.unitId);
        for (const p of cmd.items) {
          const it = r.inventory.find(i => i.uid === p.uid); if (!it) continue;
          it.placed = !!p.placed;
          it.x = Math.max(0, Math.min(N - 1, p.x | 0)); it.y = Math.max(0, Math.min(N - 1, p.y | 0));
          it.rot = (p.rot | 0) % 2; it.side = p.side === 'L' ? 'L' : 'R'; it.pos = Math.max(0, Math.min(N - 1, p.pos | 0));
        }
        return { ok: true };
      }
      case 'restyle': {
        const r = room(state, cmd.unitId);
        const it = r.inventory.find(i => i.uid === cmd.uid); if (!it) return fail('가구를 찾을 수 없어요');
        if (cmd.color) {
          if (!PALETTE[cmd.color]) return fail('없는 색상이에요');
          if (it.color === cmd.color) return { ok: true };
          if (!spend(CONFIG.recolorCost)) return fail(`코인이 부족해요 (🪙 ${CONFIG.recolorCost} 필요)`);
          it.color = cmd.color;
        } else if (cmd.style) {
          if (!STYLES[cmd.style]) return fail('없는 스타일이에요');
          if (it.style === cmd.style) return { ok: true };
          if (!spend(CONFIG.restyleCost)) return fail(`코인이 부족해요 (🪙 ${CONFIG.restyleCost} 필요)`);
          it.style = cmd.style;
        }
        return { ok: true };
      }
      case 'wallpaper': {
        const key = cmd.key === 'floor' ? 'floor' : 'wall';
        if (!ROOM_COLORS[key].some(([, hex]) => hex === cmd.hex)) return fail('없는 색이에요');
        const r = room(state, cmd.unitId);
        if (r[key] === cmd.hex) return { ok: true };
        if (!spend(CONFIG.wallpaperCost)) return fail(`코인이 부족해요 (🪙 ${CONFIG.wallpaperCost} 필요)`);
        r[key] = cmd.hex;
        return { ok: true };
      }
      case 'buyFrame': {
        const r = room(state, cmd.unitId);
        if (r.inventory.some(i => i.id === 'photo_frame')) return fail('이 방에는 이미 사진 액자가 있어요');
        if (!spend(ITEMS.photo_frame.cost)) return fail(`코인이 부족해요 (🪙 ${ITEMS.photo_frame.cost} 필요)`);
        const it = addItem(state, cmd.unitId, 'photo_frame', ctx.today);
        return { ok: true, result: { uid: it.uid } };
      }
      case 'buyCoupon': {
        const cp = (ctx.coupons || CONFIG.coupons).find(c => c.id === cmd.id); if (!cp) return fail('없는 쿠폰이에요');
        if (!spend(cp.cost)) return fail(`코인이 부족해요 (🪙 ${cp.cost} 필요)`);
        state.coupons.push({ id: cp.id, name: cp.name, date: ctx.today, status: 'pending' });
        state.pendingApprovals.push({ type: 'coupon', id: cp.id, name: cp.name, date: ctx.today });
        return { ok: true };
      }
      case 'photo': {
        if (cmd.consent !== true) return fail('개인정보·초상권·저작권 확인에 동의해야 올릴 수 있어요');
        const r = room(state, cmd.unitId);
        const it = r.inventory.find(i => i.uid === cmd.uid && i.id === 'photo_frame'); if (!it) return fail('사진 액자를 찾을 수 없어요');
        const month = ctx.today.slice(0, 7);
        if (state.photoMonths[month]) return fail('커스텀 사진은 한 달에 한 번만 올릴 수 있어요');
        if (typeof cmd.img !== 'string' || !cmd.img.startsWith('data:image/jpeg;base64,') || cmd.img.length > CONFIG.photoMaxChars) return fail('사진 형식이 맞지 않아요');
        it.img = cmd.img; it.approved = false;
        state.photoMonths[month] = true;
        state.pendingApprovals.push({ type: 'photo', unitId: cmd.unitId, uid: it.uid, date: ctx.today });
        return { ok: true };
      }
      case 'conceptFrame': {
        // 한 단원의 성취기준을 모두 통과하면 그 단원의 개념도 액자 1개
        const prog = unitProgress(state, topicsOf(ctx), cmd.unitId);
        if (!prog.total) return fail('단원을 찾을 수 없어요');
        if (state.conceptMaps[cmd.unitId]) return fail('이 단원의 개념도 액자는 이미 받았어요');
        if (prog.passed < prog.total) return fail(`이 단원의 성취기준 ${prog.total}개를 모두 통과해야 해요 (지금 ${prog.passed}개)`);
        if (typeof cmd.img !== 'string' || !cmd.img.startsWith('data:image/png;base64,') || cmd.img.length > CONFIG.photoMaxChars) return fail('개념도 이미지가 올바르지 않아요');
        const it = addItem(state, cmd.unitId, 'concept_frame', ctx.today, { img: cmd.img, approved: true });
        state.conceptMaps[cmd.unitId] = true;
        return { ok: true, result: { uid: it.uid } };
      }
      case 'settings': {
        if (!['open', 'knock', 'private'].includes(cmd.privacy)) return fail('잘못된 공개 설정이에요');
        state.settings.privacy = cmd.privacy;
        return { ok: true };
      }
      case 'submit': {
        const tid = cmd.topicId || cmd.unitId;
        const topic = topicsOf(ctx).find(t => t.id === tid); if (!topic) return fail('성취기준을 찾을 수 없어요');
        if (!topic.keyConcepts) return fail('이 성취기준은 서버에서만 판정할 수 있어요');
        const text = String(cmd.text || '').slice(0, 2000);
        if (!text.trim()) return fail('요약을 입력해 주세요');
        return { ok: true, result: submit(state, topic, cmd.answers || {}, text, ctx.today, ctx.rng || Math.random, ctx.events) };
      }
      default:
        return fail('알 수 없는 명령이에요');
    }
  }

  /* ---------- 방문자용 공개 뷰 (평가 정보·괴물·미승인 사진 제외) ---------- */
  function publicView(state) {
    const rooms = {};
    Object.keys(state.rooms).forEach(k => {
      const r = state.rooms[k];
      rooms[k] = { wall: r.wall, floor: r.floor, monster: null,
        inventory: r.inventory.filter(i => i.placed && !(i.id === 'photo_frame' && !i.approved)).map(i => Object.assign({}, i)) };
    });
    const summaries = state.records.filter(r => r.pass).map(r => ({ key: r.date + '|' + (r.topicId || r.unitId), date: r.date, unitId: r.unitId, topicId: r.topicId || r.unitId, text: r.summary }));
    return { name: state.student ? state.student.name : '', rooms, summaries };
  }

  return { VERSION, N, newState, migrate, room, footprint, randomFreeTile, addItem, eventActive, activeEvents, defaultEvents, rollItem, monthStats, unitProgress, grade, submit, apply, publicView, groupUnits, unitIdOf };
})();
