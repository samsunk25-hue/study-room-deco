// index.html 의 css/js 참조에 버전 꼬리표(?v=시각)를 붙여 학생 브라우저 캐시를 무효화한다. 커밋 전에 실행.
const fs = require('fs');
const path = require('path');
const P = path.resolve(__dirname, '..', 'index.html');
const v = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);   // YYYYMMDDHHMM
let s = fs.readFileSync(P, 'utf8');
s = s.replace(/(href|src)="((?:css|js)\/[\w.-]+\.(?:css|js))(?:\?v=\d+)?"/g, `$1="$2?v=${v}"`);
fs.writeFileSync(P, s);
console.log('index.html 자원 버전:', v);
