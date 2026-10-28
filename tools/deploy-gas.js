#!/usr/bin/env node
/* =====================================================================
 *  tools/deploy-gas.js — Apps Script 서버를 명령 한 줄로 갱신
 *
 *  사용법
 *    node tools/deploy-gas.js            # 빌드 + clasp push + 기존 배포에 새 버전 반영
 *    node tools/deploy-gas.js --build    # gas/dist 만 만들고 끝 (수동 복사용)
 *    node tools/deploy-gas.js --push     # 빌드 + push 만 (배포는 하지 않음)
 *
 *  준비 (처음 한 번)
 *    1. npm i -g @google/clasp
 *    2. https://script.google.com/home/usersettings 에서 "Google Apps Script API" 켜기
 *    3. clasp login   (브라우저에서 구글 로그인)
 *    4. gas/clasp.config.json 작성:
 *       { "scriptId": "<Apps Script 프로젝트 설정 → 스크립트 ID>",
 *         "deploymentId": "<배포 → 배포 관리 → 배포 ID>" }
 *  이후에는 js/catalog.js, judge.js, engine.js, units.js, gas/Code.gs 를 고친 뒤
 *  이 스크립트만 실행하면 Apps Script 편집기를 열 필요가 없다. (웹앱 URL 은 그대로 유지)
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'gas', 'dist');
const CFG = path.join(ROOT, 'gas', 'clasp.config.json');
const arg = process.argv[2] || '';

// 1) gas/dist 조립 (서버에 올라가는 파일 = 공용 엔진 + 단원 데이터 + 서버 코드)
fs.mkdirSync(DIST, { recursive: true });
for (const f of fs.readdirSync(DIST)) if (f !== '.clasp.json') fs.rmSync(path.join(DIST, f), { force: true });   // 폴더 자체는 지우지 않음(열려 있으면 EPERM)
const files = [
  ['gas/Code.gs', 'Code.js'],
  ['js/catalog.js', 'catalog.js'],
  ['js/judge.js', 'judge.js'],
  ['js/engine.js', 'engine.js'],
  ['js/units.js', 'units.js'],
];
for (const [src, dst] of files) {
  const p = path.join(ROOT, src);
  if (!fs.existsSync(p)) { console.error('없음:', src); process.exit(1); }
  fs.copyFileSync(p, path.join(DIST, dst));
}
fs.writeFileSync(path.join(DIST, 'appsscript.json'), JSON.stringify({
  timeZone: 'Asia/Seoul',
  dependencies: {},
  exceptionLogging: 'STACKDRIVER',
  runtimeVersion: 'V8',
  webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' },
}, null, 2));
console.log('✓ gas/dist 조립 완료:', files.map(f => f[1]).join(', '), '+ appsscript.json');
if (arg === '--build') { console.log('수동 복사: gas/dist 의 각 파일 내용을 Apps Script 같은 이름의 파일에 붙여 넣으세요.'); process.exit(0); }

// 2) clasp 설정
if (!fs.existsSync(CFG)) {
  console.error('\n✗ gas/clasp.config.json 이 없어요. 아래 형식으로 만들어 주세요.\n' +
    '{ "scriptId": "Apps Script 프로젝트 설정 → 스크립트 ID", "deploymentId": "배포 → 배포 관리 → 배포 ID" }');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
if (!cfg.scriptId) { console.error('✗ scriptId 가 비어 있어요'); process.exit(1); }
fs.writeFileSync(path.join(DIST, '.clasp.json'), JSON.stringify({ scriptId: cfg.scriptId, rootDir: '.' }));

const run = cmd => { console.log('$', cmd); execSync(cmd, { cwd: DIST, stdio: 'inherit', shell: true }); };
try {
  run('clasp push -f');                                   // 편집기의 파일을 통째로 교체
  if (arg === '--push') process.exit(0);
  if (!cfg.deploymentId) { console.log('deploymentId 가 없어 배포는 건너뜀 (Apps Script에서 "배포 관리 → 새 버전"을 눌러 주세요)'); process.exit(0); }
  const desc = 'auto ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
  run(`clasp deploy -i ${cfg.deploymentId} -d "${desc}"`);  // 같은 URL 에 새 버전 반영
  console.log('\n✓ 서버 갱신 완료. 학생 앱은 그대로 두면 됩니다.');
} catch (e) {
  console.error('\n✗ 실패. clasp login 이 되어 있는지, Apps Script API 가 켜져 있는지 확인하세요.');
  process.exit(1);
}
