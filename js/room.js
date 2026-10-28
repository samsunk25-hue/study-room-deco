/* =====================================================================
 *  room.js — 2.5D 아이소메트릭 방 렌더링 + 드래그 앤 드롭 배치
 *  createRoom(canvas, () => roomObject, hooks) 로 인스턴스 생성 (내 방 / 친구 방 각각)
 *  (이미지 에셋 없이 캔버스 벡터로 가구를 그림 → 색상/스타일 실시간 리폼)
 * ===================================================================== */
function createRoom(cv, roomGetter, hk) {
  const N = 8;            // 타일 수 (N x N)
  const TW = 64, TH = 32; // 타일 가로/세로(px)
  const WALL_H = 150;
  const S = 1.4;            // 화면 확대 배율 (방이 캔버스를 더 채우도록)

  let canvas, ctx, ox, oy, getRoom, hooks;
  let selected = null;     // 선택된 아이템 uid
  let drag = null;         // { uid, offX, offY, orig:{x,y,side}, moved }
  let hover = null;        // 드래그 중 미리보기 타일
  let bboxes = [];         // 히트 테스트용 화면 바운딩 박스
  let bb = null;           // 현재 그리는 아이템의 bbox 누적
  let imgCache = {};
  let activeSynergy = {};  // id → true
  let effects = [];        // 일회성 이펙트 (정화 파티클 등)
  let t = 0;

  /* ---------- 좌표 ---------- */
  function P(x, y, z = 0) { return { x: ox + (x - y) * TW / 2, y: oy + (x + y) * TH / 2 - z }; }
  function tileAt(sx, sy) {
    const dx = (sx - ox) / (TW / 2), dy = (sy - oy) / (TH / 2);
    return { x: Math.floor((dx + dy) / 2), y: Math.floor((dy - dx) / 2) };
  }
  function shade(hex, f) {
    if (hex.startsWith('rgb')) return hex;
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const tgt = f > 0 ? 255 : 0, a = Math.abs(f);
    r = Math.round(r + (tgt - r) * a); g = Math.round(g + (tgt - g) * a); b = Math.round(b + (tgt - b) * a);
    return `rgb(${r},${g},${b})`;
  }
  function track(p) { if (!bb) return; bb.x0 = Math.min(bb.x0, p.x); bb.y0 = Math.min(bb.y0, p.y); bb.x1 = Math.max(bb.x1, p.x); bb.y1 = Math.max(bb.y1, p.y); }

  /* ---------- 기본 도형 ---------- */
  function poly(pts, fill, stroke) {
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    pts.forEach(track);
  }
  /** 바닥 타일 [x,x+w)×[y,y+d), 높이 z 에서 h px 만큼 솟은 상자 */
  function box(x, y, z, w, d, h, c) {
    const top = [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)];
    const left = [P(x, y + d, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z), P(x, y + d, z)];
    const right = [P(x + w, y, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z), P(x + w, y, z)];
    const line = shade(c, -0.45);
    poly(left, shade(c, -0.18), line);
    poly(right, shade(c, -0.34), line);
    poly(top, shade(c, 0.18), line);
  }
  function blob(x, y, z, rx, ry, c, stroke) {
    const p = P(x, y, z);
    ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = c; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    track({ x: p.x - rx, y: p.y - ry }); track({ x: p.x + rx, y: p.y + ry });
  }
  function glow(x, y, z, r, c) {
    const p = P(x, y, z);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, c); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  }
  /** 벽걸이 패널: side 'R'(y=0 벽) / 'L'(x=0 벽), pos 타일 위치, wT 타일 폭, hPx 높이 */
  function wallPanel(side, pos, zBottom, wT, hPx, drawFn) {
    const Wpx = wT * TW / 2;
    let o;
    ctx.save();
    if (side === 'R') { o = P(pos, -0.03, zBottom + hPx); ctx.setTransform(S, 0.5 * S, 0, S, o.x * S, o.y * S); }
    else { o = P(-0.03, pos + wT, zBottom + hPx); ctx.setTransform(S, -0.5 * S, 0, S, o.x * S, o.y * S); }
    drawFn(Wpx, hPx);
    ctx.restore();
    const dir = side === 'R' ? 0.5 : -0.5;
    [[0, 0], [Wpx, Wpx * dir], [0, hPx], [Wpx, Wpx * dir + hPx]].forEach(([dx, dy]) => track({ x: o.x + dx, y: o.y + dy }));
  }

  /* ---------- 가구 그리기 (x,y 타일, w,d 회전 반영된 크기, c 메인색, a 포인트색) ---------- */
  const BOOK_COLORS = ['#d94848', '#4f8fe0', '#f2c14e', '#5fc8b0', '#9b7fd4', '#f08cb4'];
  const DRAW = {
    bed(x, y, w, d, c, a) {
      box(x, y, 0, w, d, 12, a);
      box(x + 0.08, y + 0.08, 12, w - 0.16, d - 0.16, 9, c);
      if (d >= w) box(x + 0.2, y + 0.15, 21, w - 0.4, 0.55, 5, '#f7f7f7');
      else box(x + 0.15, y + 0.2, 21, 0.55, d - 0.4, 5, '#f7f7f7');
      box(x + 0.15, y + (d >= w ? 0.9 : 0.15), 21, w - 0.3, d - (d >= w ? 1.05 : 0.3), 3, shade(c, -0.1));
    },
    desk(x, y, w, d, c, a, it) {
      const L = 0.12;
      [[x + 0.05, y + 0.05], [x + w - L - 0.05, y + 0.05], [x + 0.05, y + d - L - 0.05], [x + w - L - 0.05, y + d - L - 0.05]]
        .forEach(([lx, ly]) => box(lx, ly, 0, L, L, 28, a));
      box(x, y, 28, w, d, 4, c);
      box(x + w * 0.3, y + d * 0.3, 32, w * 0.35, d * 0.45, 1.5, '#2b2f36');
      box(x + w * 0.3, y + d * 0.28, 33, w * 0.35, 0.04, 13, '#3a4250');
      if (activeSynergy.study) glow(x + w / 2, y + d / 2, 40, 44, 'rgba(255,220,120,0.35)');
    },
    chair(x, y, w, d, c, a) {
      box(x + 0.3, y + 0.3, 0, 0.4, 0.4, 16, a);
      box(x + 0.2, y + 0.2, 16, 0.6, 0.6, 4, c);
      box(x + 0.2, y + 0.2, 20, 0.6, 0.1, 18, c);
    },
    bookshelf(x, y, w, d, c, a) {
      const vert = d > w;             // 회전 시 세로 방향
      const bw = vert ? 0.6 : w, bd = vert ? d : 0.6;
      const bx = x + (vert ? 0.2 : 0), by = y + (vert ? 0 : 0.2);
      box(bx, by, 0, bw, bd, 72, c);
      [22, 46].forEach(z => box(bx - 0.02, by - 0.02, z, bw + 0.04, bd + 0.04, 2, a));
      [2, 24, 48].forEach((z, row) => {
        for (let k = 0; k < 5; k++) {
          const h = 14 + ((k * 7 + row * 3) % 6);
          if (vert) box(bx + 0.42, by + 0.1 + k * (bd - 0.2) / 5, z, 0.25, 0.14, h, BOOK_COLORS[(k + row) % 6]);
          else box(bx + 0.1 + k * (bw - 0.2) / 5, by + 0.42, z, 0.14, 0.25, h, BOOK_COLORS[(k + row) % 6]);
        }
      });
    },
    rug(x, y, w, d, c, a) {
      box(x, y, 0, w, d, 2, c);
      box(x + 0.3, y + 0.3, 2, w - 0.6, d - 0.6, 0.5, a);
    },
    plant(x, y, w, d, c, a) {
      box(x + 0.3, y + 0.3, 0, 0.4, 0.4, 14, c);
      blob(x + 0.5, y + 0.5, 24, 17, 13, '#4e9a4e', '#2f6b2f');
      blob(x + 0.35, y + 0.4, 30, 9, 7, '#63b063', '#2f6b2f');
      blob(x + 0.65, y + 0.6, 32, 8, 6, '#3f8a3f', '#2f6b2f');
    },
    lamp(x, y, w, d, c, a) {
      if (activeSynergy.study) glow(x + 0.5, y + 0.5, 50, 60, 'rgba(255,230,140,0.45)');
      box(x + 0.3, y + 0.3, 0, 0.4, 0.4, 3, a);
      box(x + 0.46, y + 0.46, 3, 0.08, 0.08, 42, a);
      box(x + 0.2, y + 0.2, 45, 0.6, 0.6, 13, c);
      glow(x + 0.5, y + 0.5, 50, 22, 'rgba(255,240,180,0.6)');
    },
    flask(x, y, w, d, c, a) {
      blob(x + 0.5, y + 0.5, 10, 13, 10, 'rgba(215,235,245,0.9)', '#7fa3b5');
      blob(x + 0.5, y + 0.5, 7, 10, 6, c);
      box(x + 0.42, y + 0.42, 16, 0.16, 0.16, 12, 'rgba(215,235,245,0.9)');
      if (activeSynergy.boil) {
        for (let i = 0; i < 5; i++) {
          const ph = (t / 600 + i * 0.37) % 1;
          blob(x + 0.35 + (i % 3) * 0.15, y + 0.5, 12 + ph * 34, 3 + i % 2, 3 + i % 2, `rgba(255,255,255,${0.9 - ph * 0.8})`);
        }
      }
    },
    alcohol_lamp(x, y, w, d, c, a) {
      box(x + 0.3, y + 0.3, 0, 0.4, 0.4, 10, '#e4dccb');
      box(x + 0.45, y + 0.45, 10, 0.1, 0.1, 6, '#777');
      const f = Math.sin(t / 90) * 2;
      blob(x + 0.5, y + 0.5, 22 + f, 5, 9 + f, '#ff9f3b');
      blob(x + 0.5, y + 0.5, 21 + f, 2.5, 5, '#fff2a8');
    },
    poster() {},
    sofa(x, y, w, d, c, a) {
      box(x, y, 0, w, d, 12, c);
      if (w >= d) { box(x, y, 12, w, 0.3, 16, c); box(x, y, 12, 0.25, d, 7, c); box(x + w - 0.25, y, 12, 0.25, d, 7, c); }
      else { box(x, y, 12, 0.3, d, 16, c); box(x, y, 12, w, 0.25, 7, c); box(x, y + d - 0.25, 12, w, 0.25, 7, c); }
      box(x + 0.3, y + 0.3, 12, w - 0.6, d - 0.6, 3, shade(c, 0.1));
      if (activeSynergy.nap) {
        const p = P(x + w / 2, y + d / 2, 40 + Math.sin(t / 400) * 3);
        ctx.font = '16px sans-serif'; ctx.fillStyle = '#6b7280'; ctx.fillText('z', p.x + 8, p.y); ctx.fillText('Z', p.x + 16, p.y - 12);
      }
    },
    globe(x, y, w, d, c, a) {
      box(x + 0.35, y + 0.35, 0, 0.3, 0.3, 4, a);
      box(x + 0.47, y + 0.47, 4, 0.06, 0.06, 14, a);
      blob(x + 0.5, y + 0.5, 30, 15, 15, '#4f8fe0', '#2b4f8a');
      blob(x + 0.43, y + 0.5, 33, 6, 5, '#5a9a4a'); blob(x + 0.58, y + 0.5, 25, 5, 7, '#5a9a4a');
    },
    cat(x, y, w, d, c, a) {
      blob(x + 0.5, y + 0.55, 8, 14, 10, c, shade(c, -0.4));
      blob(x + 0.5, y + 0.35, 20, 10, 9, c, shade(c, -0.4));
      const h = P(x + 0.5, y + 0.35, 20);
      ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(h.x - 8, h.y - 5); ctx.lineTo(h.x - 6, h.y - 15); ctx.lineTo(h.x - 1, h.y - 8); ctx.fill();
      ctx.beginPath(); ctx.moveTo(h.x + 8, h.y - 5); ctx.lineTo(h.x + 6, h.y - 15); ctx.lineTo(h.x + 1, h.y - 8); ctx.fill();
      ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(h.x - 3, h.y - 1, 1.5, 0, 7); ctx.arc(h.x + 3, h.y - 1, 1.5, 0, 7); ctx.fill();
    },
    clock() {},
    piano(x, y, w, d, c, a) {
      box(x, y, 0, w, d, 36, c);
      if (w >= d) { box(x + 0.05, y + d - 0.38, 36, w - 0.1, 0.32, 3, '#fafafa'); for (let k = 0; k < 7; k++) box(x + 0.12 + k * (w - 0.2) / 7, y + d - 0.38, 39, 0.08, 0.16, 2, '#111'); box(x, y, 36, w, d - 0.4, 6, shade(c, -0.1)); }
      else { box(x + w - 0.38, y + 0.05, 36, 0.32, d - 0.1, 3, '#fafafa'); for (let k = 0; k < 7; k++) box(x + w - 0.38, y + 0.12 + k * (d - 0.2) / 7, 39, 0.16, 0.08, 2, '#111'); box(x, y, 36, w - 0.4, d, 6, shade(c, -0.1)); }
    },
    telescope(x, y, w, d, c, a) {
      [[0.2, 0.2], [0.7, 0.2], [0.45, 0.75]].forEach(([lx, ly]) => box(x + lx, y + ly, 0, 0.08, 0.08, 30, a));
      box(x + 0.35, y + 0.35, 30, 0.3, 0.3, 4, a);
      box(x + 0.15, y + 0.4, 34, 0.75, 0.2, 10, c);
      blob(x + 0.15, y + 0.5, 39, 5, 5, '#9bd3ff', '#355');
    },
    pagoda(x, y, w, d, c, a) {
      box(x + 0.1, y + 0.1, 0, 0.8, 0.8, 6, '#b8b4aa');
      for (let i = 0; i < 5; i++) {
        const s = 0.62 - i * 0.09, z = 6 + i * 13;
        box(x + 0.5 - s * 0.6 / 2, y + 0.5 - s * 0.6 / 2, z, s * 0.6, s * 0.6, 9, '#a9a59b');
        box(x + 0.5 - s / 2, y + 0.5 - s / 2, z + 9, s, s, 4, '#8f8b82');
      }
      box(x + 0.47, y + 0.47, 71, 0.06, 0.06, 10, '#8f8b82');
    },
    baekje_pot(x, y, w, d, c, a) {
      box(x + 0.28, y + 0.28, 0, 0.44, 0.44, 16, '#8a5a3a');
      box(x + 0.24, y + 0.24, 16, 0.52, 0.52, 3, '#a56a45');
      blob(x + 0.5, y + 0.5, 28, 14, 10, '#4e9a4e', '#2f6b2f');
      [[0.35, 0.4, 36], [0.6, 0.45, 40], [0.5, 0.65, 34]].forEach(([fx, fy, fz]) => blob(x + fx, y + fy, fz, 5, 5, c, shade(c, -0.3)));
    },
    photo_frame() {}, concept_frame() {},
  };

  /* 벽걸이 아이템 */
  function drawWallItem(it, def, c, a) {
    const id = it.id;
    const z = 62, h = id === 'concept_frame' ? 72 : 46;
    wallPanel(it.side, it.pos, z, def.w, h, (W, H) => {
      ctx.fillStyle = a; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff'; ctx.fillRect(4, 4, W - 8, H - 8);
      if (id === 'clock') {
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.min(W, H) / 2 - 6, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.min(W, H) / 2 - 9, 0, 7); ctx.fill();
        const now = new Date(), r = Math.min(W, H) / 2 - 11;
        const am = (now.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2, ah = ((now.getHours() % 12) / 12 + now.getMinutes() / 720) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(W / 2 + Math.cos(ah) * r * 0.55, H / 2 + Math.sin(ah) * r * 0.55); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(W / 2 + Math.cos(am) * r * 0.85, H / 2 + Math.sin(am) * r * 0.85); ctx.stroke();
      } else if (id === 'poster') {
        ctx.fillStyle = c; ctx.fillRect(6, 6, W - 12, H - 12);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.arc(W / 2, H / 2 - 4, 8, 0, 7); ctx.fill();
        ctx.fillRect(10, H - 16, W - 20, 3); ctx.fillRect(14, H - 11, W - 28, 2);
      } else {
        const img = imageFor(it);
        if (img && img.complete && img.naturalWidth) {
          if (id === 'photo_frame' && !it.approved) ctx.filter = 'grayscale(1)';
          ctx.drawImage(img, 6, 6, W - 12, H - 12);
          ctx.filter = 'none';
          if (id === 'photo_frame' && !it.approved) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(6, H - 18, W - 12, 12); ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.fillText('승인 대기', 8, H - 9); }
        } else {
          ctx.fillStyle = '#eee'; ctx.fillRect(6, 6, W - 12, H - 12);
          ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.fillText(id === 'photo_frame' ? '사진 없음' : '개념도', 8, H / 2 + 3);
        }
      }
    });
  }
  function imageFor(it) {
    if (!it.img) return null;
    if (!imgCache[it.uid] || imgCache[it.uid].src !== it.img) { const im = new Image(); im.src = it.img; imgCache[it.uid] = im; }
    return imgCache[it.uid];
  }

  /* 먼지 괴물 */
  function drawMonster(m) {
    const wob = Math.sin(t / 250) * 2;
    blob(m.x + 0.5, m.y + 0.5, 2, 16, 6, 'rgba(0,0,0,0.15)');
    blob(m.x + 0.5, m.y + 0.5, 16 + wob, 16, 15, '#8d8d99', '#55555f');
    for (let i = 0; i < 8; i++) { const ang = i / 8 * Math.PI * 2; const p = P(m.x + 0.5, m.y + 0.5, 16 + wob); blob(m.x + 0.5, m.y + 0.5, 16 + wob - Math.sin(ang) * 14, 5, 5, '#8d8d99'); ctx.fillStyle = '#8d8d99'; ctx.beginPath(); ctx.arc(p.x + Math.cos(ang) * 15, p.y + Math.sin(ang) * 12, 4, 0, 7); ctx.fill(); }
    const p = P(m.x + 0.5, m.y + 0.5, 18 + wob);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x - 6, p.y, 4.5, 0, 7); ctx.arc(p.x + 6, p.y, 4.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(p.x - 5, p.y, 2, 0, 7); ctx.arc(p.x + 7, p.y, 2, 0, 7); ctx.fill();
    ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.x - 5, p.y + 7); ctx.quadraticCurveTo(p.x, p.y + 4, p.x + 5, p.y + 7); ctx.stroke();
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#444'; ctx.textAlign = 'center'; ctx.fillText('오개념 먼지 괴물', p.x, p.y - 28); ctx.textAlign = 'left';
  }

  /* ---------- 상태 헬퍼 ---------- */
  function footprint(it) {
    const def = ITEMS[it.id];
    return it.rot % 2 ? { w: def.d, d: def.w } : { w: def.w, d: def.d };
  }
  function placedItems() { return getRoom().inventory.filter(i => i.placed); }
  function overlaps(a, b) {
    const da = ITEMS[a.id], db = ITEMS[b.id];
    if (da.wall || db.wall) {
      if (!(da.wall && db.wall)) return false;
      return a.side === b.side && Math.abs(a.pos - b.pos) < Math.max(da.w, db.w);
    }
    const fa = footprint(a), fb = footprint(b);
    return a.x < b.x + fb.w && b.x < a.x + fa.w && a.y < b.y + fb.d && b.y < a.y + fa.d;
  }
  function isValid(it) {
    const def = ITEMS[it.id];
    if (def.wall) {
      if (it.pos < 0 || it.pos + def.w > N) return false;
    } else {
      const f = footprint(it);
      if (it.x < 0 || it.y < 0 || it.x + f.w > N || it.y + f.d > N) return false;
      const m = getRoom().monster;
      if (m && it.x <= m.x && m.x < it.x + f.w && it.y <= m.y && m.y < it.y + f.d) return false;
    }
    return !placedItems().some(o => o.uid !== it.uid && overlaps(it, o));
  }
  function findFreeSpot(it) {
    const def = ITEMS[it.id];
    if (def.wall) {
      for (const side of ['R', 'L']) for (let pos = 1; pos + def.w <= N; pos++) {
        const test = { ...it, side, pos, placed: true };
        if (isValid(test)) return { side, pos };
      }
      return null;
    }
    for (let s = 0; s < N * 2; s++) for (let x = 0; x <= s; x++) {
      const y = s - x; if (x >= N || y >= N) continue;
      const test = { ...it, x, y, placed: true };
      if (isValid(test)) return { x, y };
    }
    return null;
  }
  function randomFreeTile() {
    const free = [];
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
      const test = { uid: -1, id: 'chair', x, y, rot: 0, placed: true };
      if (!placedItems().some(o => overlaps(test, o))) free.push({ x, y });
    }
    return free.length ? free[Math.floor(Math.random() * free.length)] : { x: N - 1, y: N - 1 };
  }
  function checkSynergies() {
    const items = placedItems();
    const found = [];
    for (const s of SYNERGIES) {
      const A = items.filter(i => i.id === s.items[0]), B = items.filter(i => i.id === s.items[1]);
      const near = A.some(a => B.some(b => {
        const fa = footprint(a), fb = footprint(b);
        const dx = Math.max(b.x - (a.x + fa.w), a.x - (b.x + fb.w), 0);
        const dy = Math.max(b.y - (a.y + fa.d), a.y - (b.y + fb.d), 0);
        return dx <= 1 && dy <= 1;
      }));
      if (near) found.push(s.id);
    }
    const next = {}; found.forEach(id => next[id] = true);
    const newly = found.filter(id => !activeSynergy[id]);
    activeSynergy = next;
    return { active: found, newly };
  }

  /* ---------- 렌더 ---------- */
  function render() {
    const r0 = getRoom();
    t = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    bboxes = []; bb = null;

    // 벽
    const wall = r0.wall, floor = r0.floor;
    poly([P(0, 0, WALL_H), P(0, N, WALL_H), P(0, N, 0), P(0, 0, 0)], shade(wall, -0.06), shade(wall, -0.3));
    poly([P(0, 0, WALL_H), P(N, 0, WALL_H), P(N, 0, 0), P(0, 0, 0)], wall, shade(wall, -0.3));
    // 걸레받이
    poly([P(0, N, 8), P(0, 0, 8), P(0, 0, 0), P(0, N, 0)], shade(wall, -0.25));
    poly([P(0, 0, 8), P(N, 0, 8), P(N, 0, 0), P(0, 0, 0)], shade(wall, -0.2));
    // 창문 (오른쪽 벽)
    wallPanel('R', 4.6, 70, 2.2, 56, (W, H) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#bfe3ff'; ctx.fillRect(4, 4, W - 8, H - 8); ctx.fillStyle = '#fff'; ctx.fillRect(W / 2 - 1.5, 4, 3, H - 8); ctx.fillRect(4, H / 2 - 1.5, W - 8, 3); ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.arc(W * 0.72, H * 0.35, 6, 0, 7); ctx.fill(); });

    // 바닥
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
      const c = (x + y) % 2 ? floor : shade(floor, 0.07);
      poly([P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)], c, shade(floor, -0.15));
    }
    // 드래그 미리보기
    if (drag && hover) {
      const it = r0.inventory.find(i => i.uid === drag.uid);
      const def = ITEMS[it.id];
      const ok = isValid(it);
      const col = ok ? 'rgba(80,200,120,0.45)' : 'rgba(230,80,80,0.45)';
      if (!def.wall) {
        const f = footprint(it);
        poly([P(it.x, it.y, 1), P(it.x + f.w, it.y, 1), P(it.x + f.w, it.y + f.d, 1), P(it.x, it.y + f.d, 1)], col);
      }
    }

    // 아이템 정렬 (벽걸이 먼저, 바닥은 깊이순)
    const items = placedItems().slice();
    const depth = it => ITEMS[it.id].wall ? -1000 + it.pos : (() => { const f = footprint(it); return it.x + f.w + it.y + f.d; })();
    const list = items.map(it => ({ it, d: depth(it) }));
    if (r0.monster) list.push({ monster: r0.monster, d: r0.monster.x + r0.monster.y + 2 });
    list.sort((a, b) => a.d - b.d);

    for (const e of list) {
      if (e.monster) { bb = null; drawMonster(e.monster); continue; }
      const it = e.it, def = ITEMS[it.id];
      const c = (PALETTE[it.color] || PALETTE.wood).hex;
      const a = (STYLES[it.style] || STYLES.basic).accent;
      bb = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
      ctx.globalAlpha = drag && drag.uid === it.uid ? 0.75 : 1;
      if (def.wall) drawWallItem(it, def, c, a);
      else { const f = footprint(it); DRAW[it.id](it.x, it.y, f.w, f.d, c, a, it); }
      ctx.globalAlpha = 1;
      if (selected === it.uid) {
        ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2;
        ctx.strokeRect(bb.x0 - 4, bb.y0 - 4, bb.x1 - bb.x0 + 8, bb.y1 - bb.y0 + 8); ctx.restore();
      }
      bboxes.push({ uid: it.uid, ...bb });
      bb = null;
    }

    // 이펙트
    effects = effects.filter(e => t - e.start < e.dur);
    for (const e of effects) {
      const k = (t - e.start) / e.dur;
      for (let i = 0; i < 14; i++) {
        const ang = i / 14 * Math.PI * 2;
        const p = P(e.x + 0.5, e.y + 0.5, 16 + k * 40);
        ctx.fillStyle = `rgba(255,215,80,${1 - k})`;
        ctx.beginPath(); ctx.arc(p.x + Math.cos(ang) * k * 50, p.y + Math.sin(ang) * k * 30, 4, 0, 7); ctx.fill();
      }
      ctx.fillStyle = `rgba(60,60,60,${1 - k})`; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(e.text, P(e.x + 0.5, e.y + 0.5, 60 + k * 30).x, P(e.x + 0.5, e.y + 0.5, 60 + k * 30).y); ctx.textAlign = 'left';
    }

    if (hooks.isLocked && hooks.isLocked()) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(0, 0, canvas.width / S, canvas.height / S);
    }
  }
  function loop() { render(); requestAnimationFrame(loop); }

  /* ---------- 입력 ---------- */
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { sx: (e.clientX - r.left) * canvas.width / r.width / S, sy: (e.clientY - r.top) * canvas.height / r.height / S };
  }
  function bind() {
    canvas.addEventListener('pointerdown', e => {
      if (hooks.readOnly && hooks.readOnly()) return;
      if (hooks.isLocked && hooks.isLocked()) { hooks.onLockedTouch && hooks.onLockedTouch(); return; }
      const { sx, sy } = pos(e);
      let hit = null;
      for (let i = bboxes.length - 1; i >= 0; i--) { const b = bboxes[i]; if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) { hit = b.uid; break; } }
      selected = hit;
      hooks.onSelect && hooks.onSelect(hit);
      if (hit) {
        const it = getRoom().inventory.find(i => i.uid === hit);
        const tl = tileAt(sx, sy);
        drag = { uid: hit, offX: tl.x - it.x, offY: tl.y - it.y, orig: { x: it.x, y: it.y, side: it.side, pos: it.pos }, moved: false, sx, sy };
        canvas.setPointerCapture(e.pointerId);
      }
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const { sx, sy } = pos(e);
      if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 4) return;
      drag.moved = true;
      const it = getRoom().inventory.find(i => i.uid === drag.uid);
      const def = ITEMS[it.id];
      if (def.wall) {
        it.side = sx >= ox ? 'R' : 'L';
        it.pos = Math.max(0, Math.min(N - def.w, Math.floor(Math.abs(sx - ox) / (TW / 2))));
      } else {
        const tl = tileAt(sx, sy);
        const f = footprint(it);
        it.x = Math.max(0, Math.min(N - f.w, tl.x - drag.offX));
        it.y = Math.max(0, Math.min(N - f.d, tl.y - drag.offY));
      }
      hover = true;
    });
    const end = e => {
      if (!drag) return;
      const it = getRoom().inventory.find(i => i.uid === drag.uid);
      if (it && drag.moved) {
        if (!isValid(it)) { Object.assign(it, drag.orig); hooks.onInvalid && hooks.onInvalid(); }
        else hooks.onChange && hooks.onChange();
      }
      drag = null; hover = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /* ---------- 공개 API ---------- */
  function init() {
    canvas = cv; ctx = cv.getContext('2d'); getRoom = roomGetter; hooks = hk || {};
    ox = cv.width / 2 / S; oy = 160;
    bind();
    requestAnimationFrame(loop);
  }
  function select(uid) { selected = uid; hooks.onSelect && hooks.onSelect(uid); }
  function getSelected() { return selected; }
  function place(it) {
    const spot = findFreeSpot(it);
    if (!spot) return false;
    Object.assign(it, spot, { placed: true });
    if (it.rot === undefined) it.rot = 0;
    selected = it.uid;
    return true;
  }
  function unplace(it) { it.placed = false; if (selected === it.uid) selected = null; }
  function rotate(it) {
    if (ITEMS[it.id].wall) return false;
    const before = it.rot || 0;
    it.rot = (before + 1) % 2;
    if (!isValid(it)) { it.rot = before; return false; }
    return true;
  }
  function purifyEffect(x, y, text) { effects.push({ x, y, start: performance.now(), dur: 1400, text: text || '정화 완료!' }); }
  function snapshot() { return canvas.toDataURL('image/png'); }

  function clearSelection() { selected = null; drag = null; }
  init();
  return { select, getSelected, clearSelection, place, unplace, rotate, isValid, findFreeSpot, randomFreeTile, checkSynergies, purifyEffect, snapshot, footprint, N };
}
