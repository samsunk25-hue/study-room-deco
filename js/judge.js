/* =====================================================================
 *  judge.js — 서술형 요약 판정 (규칙 기반, 브라우저 로컬 모드 + GAS 서버 공용)
 *  정답을 알려주지 않고 '발판(Scaffolding) 힌트'만 돌려준다.
 *  학생 데이터는 외부 AI 로 전송하지 않는다.
 * ===================================================================== */
const Judge = (() => {
  const CAUSAL = /(때문|그래서|따라서|하면|이므로|결과|원인|영향|되면|면서|통해|위해|으로써|해서|니까)/;

  function normalize(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }

  function evaluate(text, unit) {
    const raw = String(text || '').trim();
    const norm = normalize(raw);
    const total = unit.keyConcepts.length;
    const res = { pass: false, score: 0, hits: [], total, hint: '', feedback: '', reason: '' };

    // 1) 길이
    if (raw.length < CONFIG.minLength) {
      res.reason = 'too_short';
      res.feedback = '조금 더 자세히!';
      res.hint = `최소 ${CONFIG.minLength}자 이상 써 보세요. 오늘 배운 개념이 "왜", "어떻게" 연결되는지 설명하면 좋아요.`;
      return res;
    }

    // 2) 무의미어 / 반복 문자
    const hangul = (raw.match(/[가-힣]/g) || []).length;
    if (hangul / Math.max(1, norm.length) < 0.4 || /(.)\1{4,}/.test(norm)) {
      res.reason = 'nonsense';
      res.feedback = '의미 있는 문장이 필요해요.';
      res.hint = '배운 내용을 자신의 말로 문장으로 풀어 써 보세요. 핵심 단어 2~3개를 먼저 떠올리고 그 관계를 설명하면 쉬워요.';
      return res;
    }

    // 3) 교과서 복사-붙여넣기 차단
    const src = normalize(unit.sourceText || '');
    if (src) {
      for (let i = 0; i + 22 <= norm.length; i += 4) {
        if (src.includes(norm.slice(i, i + 22))) {
          res.reason = 'copy';
          res.feedback = '교과서 문장을 그대로 옮겼어요.';
          res.hint = '교과서 문장을 베끼지 말고, 친구에게 설명하듯 자기 말로 바꿔 써 보세요.';
          return res;
        }
      }
    }

    // 4) 오개념 검출 → 정답 대신 힌트
    for (const m of unit.misconceptions || []) {
      const re = m.pattern instanceof RegExp ? m.pattern : new RegExp(m.pattern);
      if (re.test(raw)) {
        res.reason = 'misconception';
        res.feedback = '오개념 몬스터 발견!';
        res.hint = m.hint;
        return res;
      }
    }

    // 5) 핵심 개념 포함 여부
    const missing = [];
    for (const c of unit.keyConcepts) {
      const terms = [c.term, ...(c.aliases || [])];
      if (terms.some(t => norm.includes(normalize(t)))) res.hits.push(c.term);
      else missing.push(c);
    }
    const need = Math.ceil(total * CONFIG.passRatio);
    const causal = CAUSAL.test(raw);

    const conceptScore = Math.round((res.hits.length / total) * 70);
    res.score = Math.min(100, conceptScore + (causal ? 20 : 0) + Math.min(10, Math.floor(raw.length / 30)));

    if (res.hits.length < need) {
      res.reason = 'missing';
      res.feedback = `핵심 개념이 ${res.hits.length}/${total}개 보여요. ${need}개 이상 필요해요.`;
      res.hint = missing[0].hint;
      return res;
    }
    if (!causal) {
      res.reason = 'no_causal';
      res.feedback = '개념은 잘 찾았어요! 이제 연결이 필요해요.';
      res.hint = '개념들이 서로 어떻게 연결되는지 "~하기 때문에", "~하면 ~된다"처럼 이유와 결과를 넣어 써 보세요.';
      return res;
    }

    res.pass = true;
    res.reason = 'ok';
    res.feedback = res.hits.length === total
      ? '완벽해요! 모든 핵심 개념을 인과관계로 연결했어요.'
      : `좋아요! 핵심 개념 ${res.hits.length}/${total}개를 잘 연결했어요.`;
    if (missing.length) res.hint = `다음엔 "${missing[0].term}"도 함께 설명해 보면 더 완벽해요.`;
    return res;
  }

  return { evaluate };
})();
