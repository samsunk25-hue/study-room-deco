/* =====================================================================
 *  catalog.js — 공용 설정/카탈로그 (브라우저 + GAS 서버 공용, 정답 정보 없음)
 *  보상 규칙·가구·색상·시너지. 단원/문항은 units.js(로컬) 또는 단원 시트(서버)
 * ===================================================================== */

const CONFIG = {
  appName: '스터디룸',
  // Google Apps Script 웹앱 URL. 비워두면 로컬 모드(이 브라우저에만 저장, 시연용).
  // 입력하면 서버 모드: 학번+비밀번호 로그인, 모든 기록은 교사 폴더에만 저장.
  gasUrl: 'https://script.google.com/macros/s/AKfycbwFFKTlFwuclnOGDavzq7FpxOpQNy6gidNqc_40mI2nusumfqyBRLQ7IS2fVvckNnQm/exec',
  // 로컬 모드 전용 교사 PIN (서버 모드에서는 구글 계정 + 관리자 승인으로 교사 인증)
  teacherPin: '0000',
  // 영감 스티커: 방문자가 남기면 받는 코인 / 하루 최대 횟수
  sticker: { coin: 5, perDay: 3 },
  visitMinutes: 30,          // 노크 허락 후 입장 가능 시간
  photoMaxChars: 90000,      // 사진 데이터 URL 최대 길이 (약 60KB)

  // 시간 잠금 (프론트엔드 1차 검증 — 최종 검증은 GAS 서버 시간 기준)
  nightLock: { enabled: true, start: 22, end: 7 },   // 22:00 ~ 07:00 앱 사용 차단
  classLock: { enabled: false, start: 9, end: 16 },  // 수업 시간엔 인테리어 잠금

  // 요약 판정 규칙 (로컬 판정)
  minLength: 30,      // 최소 글자 수
  passRatio: 0.6,     // 핵심 개념 포함 비율 (0.6 → 5개 중 3개)

  // 보상 (성취기준 하나를 하루 1회 기준으로)
  //  conceptCoin : 요약에서 핵심 개념이 하나 "열릴" 때마다 (같은 날 같은 성취기준에서 새로 연 개념만)
  //  quizCoin    : 형성평가 정답 1개당 (하루 1회)
  //  passCoin    : 요약 통과 보너스 + 가구 상자 (하루 1회)
  rewards: { conceptCoin: 10, quizCoin: 10, passCoin: 30, firstTryBonus: 20, monsterBonus: 15 },
  recolorCost: 20,
  restyleCost: 30,
  wallpaperCost: 50,
  // 상점 가구 구매 가격(희귀도별). 이벤트 한정 가구는 구매 불가
  shopPrice: { common: 80, rare: 160, epic: 320 },
  conceptMapThreshold: 4,   // 한 달 동안 통과 횟수 → AI 개념도 액자 1회 지급

  // 지역 연계 이벤트 (기간 중 퀴즈 통과 시 한정판 가구 드롭)
  event: {
    name: '부여 백제문화제 특별 주간',
    start: '2026-09-25',
    end: '2026-10-10',
    itemIds: ['pagoda', 'baekje_pot'],
    dropRate: 0.35,
  },

  // O2O 비밀 상점 (현실 교실 쿠폰)
  // 서버 모드에서는 "쿠폰" 시트(교사가 앱의 교사 모드나 시트에서 추가·수정) 가 우선. 아래는 기본값.
  coupons: [
    { id: 'seat', name: '자리 선택권', cost: 200, desc: '다음 자리 바꾸기 때 우선 선택' },
  ],
};

/* ---------------- 색상 팔레트 / 스타일 / 희귀도 ---------------- */
const PALETTE = {
  wood: { name: '우드', hex: '#b07a4a' },
  red: { name: '레드', hex: '#d94848' },
  pink: { name: '핑크', hex: '#f08cb4' },
  mint: { name: '민트', hex: '#5fc8b0' },
  blue: { name: '블루', hex: '#4f8fe0' },
  lavender: { name: '라벤더', hex: '#9b7fd4' },
  yellow: { name: '옐로우', hex: '#f2c14e' },
  gray: { name: '그레이', hex: '#8a8f99' },
  white: { name: '화이트', hex: '#eceff3' },
};

const STYLES = {
  basic: { name: '기본', accent: '#5c4632' },
  retro: { name: '레트로', accent: '#c9742a' },
  modern: { name: '모던', accent: '#2b2f36' },
  nature: { name: '자연', accent: '#5a9a4a' },
};

const RARITY = {
  common: { name: '일반', color: '#8a8f99', weight: 70 },
  rare: { name: '레어', color: '#4f8fe0', weight: 25 },
  epic: { name: '에픽', color: '#9b7fd4', weight: 5 },
};

const ROOM_COLORS = {
  wall: [['크림', '#f6ecdc'], ['스카이', '#dbeafe'], ['로즈', '#fde2e4'], ['민트', '#d9f3e8'], ['라벤더', '#e9e1f7'], ['그레이', '#e5e7eb']],
  floor: [['우드', '#d8b07c'], ['오크', '#c79a62'], ['화이트', '#e8e2d6'], ['타일', '#b9c7d6'], ['잔디', '#9fcf8a'], ['다크', '#6b5b4e']],
};

/* ---------------- 가구 카탈로그 ----------------
 *  w,d : 바닥 타일 크기 / wall: 벽걸이 여부
 *  pool: 'box'(상자 드롭) | 'shop'(상점 구매) | 'event'(이벤트) | 'special'(시스템 지급)
 */
const ITEMS = {
  bed: { name: '침대', emoji: '🛏️', w: 2, d: 3, rarity: 'common', pool: 'box' },
  desk: { name: '책상', emoji: '🪑', w: 2, d: 1, rarity: 'common', pool: 'box' },
  chair: { name: '의자', emoji: '💺', w: 1, d: 1, rarity: 'common', pool: 'box' },
  bookshelf: { name: '책장', emoji: '📚', w: 2, d: 1, rarity: 'common', pool: 'box' },
  rug: { name: '러그', emoji: '🟫', w: 3, d: 2, rarity: 'common', pool: 'box' },
  plant: { name: '화분', emoji: '🪴', w: 1, d: 1, rarity: 'common', pool: 'box' },
  lamp: { name: '스탠드 조명', emoji: '💡', w: 1, d: 1, rarity: 'common', pool: 'box' },
  flask: { name: '플라스크', emoji: '🧪', w: 1, d: 1, rarity: 'common', pool: 'box' },
  alcohol_lamp: { name: '알코올램프', emoji: '🔥', w: 1, d: 1, rarity: 'common', pool: 'box' },
  poster: { name: '포스터', emoji: '🖼️', w: 1, d: 0, rarity: 'common', pool: 'box', wall: true },
  sofa: { name: '소파', emoji: '🛋️', w: 2, d: 1, rarity: 'rare', pool: 'box' },
  globe: { name: '지구본', emoji: '🌍', w: 1, d: 1, rarity: 'rare', pool: 'box' },
  cat: { name: '고양이 인형', emoji: '🐱', w: 1, d: 1, rarity: 'rare', pool: 'box' },
  clock: { name: '벽시계', emoji: '🕰️', w: 1, d: 0, rarity: 'rare', pool: 'box', wall: true },
  piano: { name: '피아노', emoji: '🎹', w: 2, d: 1, rarity: 'epic', pool: 'box' },
  telescope: { name: '망원경', emoji: '🔭', w: 1, d: 1, rarity: 'epic', pool: 'box' },
  pagoda: { name: '정림사지 5층 석탑 미니어처', emoji: '🗼', w: 1, d: 1, rarity: 'epic', pool: 'event' },
  baekje_pot: { name: '백제 천연 염료 화분', emoji: '🌸', w: 1, d: 1, rarity: 'rare', pool: 'event' },
  photo_frame: { name: '커스텀 사진 액자', emoji: '📷', w: 1, d: 0, rarity: 'rare', pool: 'shop', wall: true, cost: 120 },
  concept_frame: { name: 'AI 개념도 액자', emoji: '🧠', w: 2, d: 0, rarity: 'epic', pool: 'special', wall: true },
};

/* ---------------- 히든 시너지 (인접 배치 시 특수 연출) ---------------- */
const SYNERGIES = [
  { id: 'boil', items: ['alcohol_lamp', 'flask'], name: '끓어오르는 실험실', desc: '알코올램프 + 플라스크 = 부글부글!' },
  { id: 'study', items: ['desk', 'lamp'], name: '집중 모드', desc: '책상 + 스탠드 = 따뜻한 불빛' },
  { id: 'nap', items: ['cat', 'sofa'], name: '낮잠 타임', desc: '소파 + 고양이 = 쿨쿨' },
];

/* 로딩 화면에 흘러가는 우수 요약 예시 (친구들의 요약이 쌓이면 함께 노출) */
const SAMPLE_SUMMARIES = [
  '열에너지를 흡수하면 입자의 운동이 활발해져서 간격이 멀어지고, 그래서 고체가 액체로 융해된다.',
  '광합성은 엽록체에서 빛에너지로 이산화탄소와 물을 포도당과 산소로 바꾸는 과정이다.',
  '성왕은 백제의 중흥을 위해 웅진에서 사비로 천도하고 국호를 남부여로 바꾸었다.',
  '이항은 등식의 성질 때문에 가능하며, 항을 옮기면 부호가 반대로 바뀐다.',
  '기체는 입자 사이 거리가 멀어서 압축이 쉽고, 액체는 입자가 가까워서 압축이 잘 안 된다.',
];
