// Rantau 번역 서버 함수 v3 — 모델 자동 대체 + 상태 진단(GET) + 남용 방지(오리진 잠금·요청 제한)
//
// 보호장치 요약:
//  1) CORS/Origin 잠금 — 허용된 도메인(앱 자신)에서 온 요청만 처리. 다른 사이트가 이 API를 못 씀.
//  2) 요청량 제한(throttle) — 같은 IP가 짧은 시간에 과도하게 부르면 429로 차단. (인스턴스별 best-effort)
//  3) 입력 크기 제한 — 한 번에 최대 40개 문장, 각 1500자.
//  ※ 최종 '요금 상한'은 Google AI Studio/Cloud 콘솔에서 API 사용량 한도를 걸어두는 것이 가장 확실합니다.

const DEFAULT_ORIGINS = [
  'https://rantau-nine.vercel.app'
];
// 추가 도메인(커스텀 도메인 등)은 Vercel 환경변수 ALLOWED_ORIGINS 에 콤마로 넣으세요.
function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_ORIGINS.concat(extra);
}
function originOf(req) {
  const o = req.headers.origin || '';
  if (o) return o;
  // Origin 이 없을 때 Referer 에서 유추
  const ref = req.headers.referer || '';
  try { if (ref) { const u = new URL(ref); return u.origin; } } catch (e) {}
  return '';
}
function isAllowed(req) {
  const o = originOf(req);
  if (!o) return false;
  if (allowedOrigins().indexOf(o) !== -1) return true;
  try {
    const h = new URL(o).hostname;
    // 모든 Vercel 배포(프로덕션+프리뷰) 허용, 로컬 개발 허용
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (h === 'vercel.app' || h.endsWith('.vercel.app')) return true;
  } catch (e) {}
  return false;
}

// ---- best-effort 요청량 제한 (인스턴스 메모리, 콜드스타트 시 초기화) ----
const HITS = new Map(); // ip -> [timestamps(ms)]
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
function throttled(ip, now) {
  if (!ip) ip = 'unknown';
  const arr = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 5000) { // 메모리 폭주 방지
    for (const k of HITS.keys()) { HITS.delete(k); if (HITS.size < 2500) break; }
  }
  return arr.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  const origin = originOf(req);
  const allow = isAllowed(req);
  // 허용된 오리진이면 그 오리진만 반사(reflect)해서 CORS 허용
  if (allow) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(allow ? 200 : 403).end(); return; }

  const key = process.env.GEMINI_API_KEY;
  // flash-lite: 무료 하루 1,000회(가장 넉넉) + 가장 저렴 → 맨 앞. 실패 시 다음 모델로 폴백.
  const MODELS = [process.env.GEMINI_MODEL, 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'].filter(Boolean);

  async function callGemini(model, texts, target) {
    const names = { ko: 'Korean', en: 'English', zh: 'Simplified Chinese', ja: 'Japanese', id: 'Indonesian' };
    const tname = names[target] || target;
    const prompt =
      'You are a translation engine. Translate every item of this JSON array into ' + tname + ' ONLY.\n' +
      'Rules:\n' +
      '- The output language MUST be ' + tname + ' for every item, no matter what language each item is written in.\n' +
      '- If an item is already written in ' + tname + ', return it unchanged.\n' +
      '- These are casual neighborhood-community posts and chat messages — translate naturally and colloquially. Keep emojis, numbers, URLs and proper nouns as-is.\n' +
      '- Do NOT add notes, explanations, romanization, or the original text. Do NOT merge or split items.\n' +
      '- Return ONLY a JSON array of strings, with EXACTLY the same length and order as the input.\n' +
      'Input: ' + JSON.stringify(texts);
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
        })
      }
    );
    if (!r.ok) { const tt = await r.text(); const err = new Error('upstream ' + r.status + ' (' + model + '): ' + tt.slice(0, 180)); err.status = r.status; throw err; }
    const d = await r.json();
    const out = JSON.parse(d.candidates[0].content.parts[0].text);
    if (!Array.isArray(out)) throw new Error('bad shape (' + model + ')');
    return out.map(String);
  }

  async function translateWithFallback(texts, target) {
    let lastErr = null;
    for (const m of MODELS) {
      try { const out = await callGemini(m, texts, target); return { out, model: m }; }
      catch (e) { lastErr = e; if (e && e.status === 429) break; } // quota 초과면 다른 모델도 같은 프로젝트라 어차피 429 → 즉시 중단
    }
    throw lastErr || new Error('all models failed');
  }

  // GET = 상태 진단 (짧은 단일 번역 1회). 진단 편의를 위해 오리진 잠금은 적용하지 않음.
  if (req.method === 'GET') {
    if (!key) { res.status(200).json({ ok: false, reason: 'GEMINI_API_KEY not set in Vercel' }); return; }
    try {
      const t = await translateWithFallback(['Hello, how are you?'], 'ko');
      res.status(200).json({ ok: true, model: t.model, sample: t.out[0], protected: true });
    } catch (e) {
      res.status(200).json({ ok: false, reason: String(e && e.message || e) });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // --- 보호 1: 오리진 잠금 ---
  if (!allow) { res.status(403).json({ error: 'forbidden origin' }); return; }

  // --- 보호 2: 요청량 제한 ---
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket && req.socket.remoteAddress || '';
  const now = Date.now();
  if (throttled(ip, now)) { res.status(429).json({ error: 'too many requests, slow down' }); return; }

  if (!key) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return; }

  const { texts, target } = req.body || {};
  if (!Array.isArray(texts) || !texts.length || !target) {
    res.status(400).json({ error: 'need { texts: [..], target: "ko|en|zh|ja|id" }' }); return;
  }
  // --- 보호 3: 입력 크기 제한 ---
  const list = texts.slice(0, 40).map(s => String(s).slice(0, 1500));
  try {
    const t = await translateWithFallback(list, target);
    res.status(200).json({ translations: t.out, model: t.model });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
