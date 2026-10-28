/* =====================================================================
 *  engine.js — 공용 게임 로직 (브라우저 로컬 모드 + GAS 서버 공용)
 *  상태(state)를 받아 명령(cmd)을 적용하는 순수 함수 모음.
 *  서버 모드에서는 이 파일이 서버에서 실행되어 코인·보상·판정을 결정한다.
 *  (catalog.js, judge.js 가 먼저 로드되어 있어야 함)
 * ===================================================================== */
const Engine = (() => {
  const N = 8;
  const VERSION = 2;
  const DEFAULT_ROOM = () => ({ wall: '#f6ecdc', floor: '#d8b07c', inventory: [], monster: null });

  /* ---------- 상태 생성 / 마이그레이션 (앱이 업데이트되어도 기존 데이터 보존) ---------- */
  function newState(student, today) {
    return {
      version: VERSION, student, coins: 0, uidSeq: 1,
      rooms: {},                 // unitId → { wall, floor, inventory[], monster }
      records: [],               // { date, unitId, attempts, rewarded, quiz, summary, score, pass, hits, reason, reward }
      coupons: [], conceptMaps: {}, photoMonths: {},
      settings: { privacy: 'knock', bypassLock: false, eventForce: false },
      synergyLog: {}, pendingApprovals: [], stickerLog: {},
      createdAt: today || '', updatedAt: today || '',
    };
  }
  function migrate(state, units) {
    if (!state || typeof state !== 'object') return null;
    if (!state.version || state.version < 2) {
      // v1: 방 하나 → v2: 단원별 방. 기존 가구는 첫 단원의 방으로 옮겨 보존
      const key = (units && units[0] && units[0].id) || 'home';
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
  function eventActive(state, today) {
    if (state.settings.eventForce) return true;
    return today >= CONFIG.event.start && today <= CONFIG.event.end;
  }
  function rollItem(state, today, rng) {
    if (eventActive(state, today) && rng() < CONFIG.event.dropRate) {
      const ids = CONFIG.event.itemIds; return ids[Math.floor(rng() * ids.length)];
    }
    const pool = Object.keys(ITEMS).filter(k => ITEMS[k].pool === 'box');
    const total = pool.reduce((s, k) => s + RARITY[ITEMS[k].rarity].weight, 0);
    let r = rng() * total;
    for (const k of pool) { r -= RARITY[ITEMS[k].rarity].weight; if (r <= 0) return k; }
    return pool[0];
  }
  function monthStats(state, month) {
    const passed = state.records.filter(r => r.pass && r.date.startsWith(month));
    return { passed, days: new Set(passed.map(r => r.date)).size };
  }
  function normAns(s) { return String(s === undefined || s === null ? '' : s).replace(/\s/g, '').toLowerCase(); }

  /* ---------- 형성평가 채점 ---------- */
  function grade(unit, answers) {
    return unit.questions.map((q, i) => {
      const a = answers ? answers[i] : null;
      const ok = q.type === 'mc' ? Number(a) === q.answer : (q.answers || []).some(x => normAns(x) === normAns(a));
      return { ok, hint: ok ? '' : q.hint };
    });
  }

  /* ---------- 요약 제출 (판정 + 기록 + 보상 + 먼지 괴물) ---------- */
  function submit(state, unit, answers, text, today, rng) {
    const g = grade(unit, answers);
    const qs = { correct: g.filter(x => x.ok).length, total: g.length };
    const j = Judge.evaluate(text, unit);
    const res = { pass: j.pass, score: j.score, hits: j.hits, total: j.total, hint: j.hint, feedback: j.feedback, reason: j.reason };

    let rec = state.records.find(r => r.unitId === unit.id && r.date === today);
    if (!rec) { rec = { date: today, unitId: unit.id, attempts: 0, rewarded: false, quiz: qs, summary: '', score: 0, pass: false, hits: [] }; state.records.push(rec); }
    rec.attempts++; rec.summary = text; rec.score = res.score; rec.pass = res.pass; rec.hits = res.hits; rec.reason = res.reason; rec.quiz = qs;

    const r = room(state, unit.id);
    const outcome = { purified: false, coins: 0, itemId: null, itemUid: null, practice: false, monster: null };
    if (res.pass) {
      if (r.monster) {
        outcome.purified = true; outcome.coins += CONFIG.rewards.monsterBonus;
        outcome.monsterAt = { x: r.monster.x, y: r.monster.y };
        r.monster = null;
      }
      if (!rec.rewarded) {
        rec.rewarded = true;
        outcome.coins += CONFIG.rewards.baseCoin + CONFIG.rewards.quizCoin * qs.correct + (rec.attempts === 1 ? CONFIG.rewards.firstTryBonus : 0);
        outcome.itemId = rollItem(state, today, rng);
        outcome.itemUid = addItem(state, unit.id, outcome.itemId, today).uid;
        rec.reward = { coins: outcome.coins, itemId: outcome.itemId };
      } else outcome.practice = true;
      state.coins += outcome.coins;
    } else if (!r.monster) {
      r.monster = Object.assign(randomFreeTile(r, rng), { unitId: unit.id, since: today });
      outcome.monster = r.monster;
    }
    return { res, outcome, quiz: g, record: { date: rec.date, attempts: rec.attempts, rewarded: rec.rewarded } };
  }

  /* ---------- 명령 적용 ----------
   *  cmd.type: layout | restyle | wallpaper | buyFrame | buyCoupon | photo | conceptFrame | settings | submit
   *  ctx: { units, today, rng }
   *  반환: { ok, error?, result? }   (ok=false 이면 state 는 변경되지 않음)
   */
  function apply(state, cmd, ctx) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, error: '잘못된 요청이에요' };
    const unitOf = id => (ctx.units || []).find(u => u.id === id);
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
        const cp = CONFIG.coupons.find(c => c.id === cmd.id); if (!cp) return fail('없는 쿠폰이에요');
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
        const month = ctx.today.slice(0, 7);
        if (state.conceptMaps[month]) return fail('이번 달 개념도 액자는 이미 받았어요');
        const st = monthStats(state, month);
        if (st.days < CONFIG.conceptMapThreshold) return fail(`이번 달 통과한 날이 ${CONFIG.conceptMapThreshold}일 이상이어야 해요`);
        if (typeof cmd.img !== 'string' || !cmd.img.startsWith('data:image/png;base64,') || cmd.img.length > CONFIG.photoMaxChars) return fail('개념도 이미지가 올바르지 않아요');
        const it = addItem(state, cmd.unitId, 'concept_frame', ctx.today, { img: cmd.img, approved: true });
        state.conceptMaps[month] = true;
        return { ok: true, result: { uid: it.uid } };
      }
      case 'settings': {
        if (!['open', 'knock', 'private'].includes(cmd.privacy)) return fail('잘못된 공개 설정이에요');
        state.settings.privacy = cmd.privacy;
        return { ok: true };
      }
      case 'submit': {
        const unit = unitOf(cmd.unitId); if (!unit) return fail('단원을 찾을 수 없어요');
        if (!unit.keyConcepts) return fail('이 단원은 서버에서만 판정할 수 있어요');
        const text = String(cmd.text || '').slice(0, 2000);
        if (!text.trim()) return fail('요약을 입력해 주세요');
        return { ok: true, result: submit(state, unit, cmd.answers || {}, text, ctx.today, ctx.rng || Math.random) };
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
    const summaries = state.records.filter(r => r.pass).map(r => ({ key: r.date + '|' + r.unitId, date: r.date, unitId: r.unitId, text: r.summary }));
    return { name: state.student ? state.student.name : '', rooms, summaries };
  }

  return { VERSION, N, newState, migrate, room, footprint, randomFreeTile, addItem, eventActive, rollItem, monthStats, grade, submit, apply, publicView };
})();
