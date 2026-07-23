// Rantau 번역 서버 함수 v2 — 모델 자동 대체 + 상태 진단(GET)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const key = process.env.GEMINI_API_KEY;
  const MODELS = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.0-flash'].filter(Boolean);

  async function callGemini(model, texts, target) {
    const names = { ko: 'Korean', en: 'English', zh: 'Simplified Chinese', ja: 'Japanese', id: 'Indonesian' };
    const prompt =
      'Translate every item of this JSON array into ' + (names[target] || target) + '.\n' +
      'These are casual secondhand-marketplace listings and chat messages — translate naturally and colloquially, keep emojis, numbers and proper nouns as-is.\n' +
      'Return ONLY a JSON array of translated strings, same length and order.\n' +
      JSON.stringify(texts);
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
    if (!r.ok) { const tt = await r.text(); throw new Error('upstream ' + r.status + ' (' + model + '): ' + tt.slice(0, 180)); }
    const d = await r.json();
    const out = JSON.parse(d.candidates[0].content.parts[0].text);
    if (!Array.isArray(out)) throw new Error('bad shape (' + model + ')');
    return out.map(String);
  }

  async function translateWithFallback(texts, target) {
    let lastErr = null;
    for (const m of MODELS) {
      try { const out = await callGemini(m, texts, target); return { out, model: m }; }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all models failed');
  }

  if (req.method === 'GET') {
    if (!key) { res.status(200).json({ ok: false, reason: 'GEMINI_API_KEY not set in Vercel' }); return; }
    try {
      const t = await translateWithFallback(['Hello, how are you?'], 'ko');
      res.status(200).json({ ok: true, model: t.model, sample: t.out[0] });
    } catch (e) {
      res.status(200).json({ ok: false, reason: String(e && e.message || e) });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!key) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return; }

  const { texts, target } = req.body || {};
  if (!Array.isArray(texts) || !texts.length || !target) {
    res.status(400).json({ error: 'need { texts: [..], target: "ko|en|zh|ja|id" }' }); return;
  }
  const list = texts.slice(0, 50).map(s => String(s).slice(0, 2000));
  try {
    const t = await translateWithFallback(list, target);
    res.status(200).json({ translations: t.out, model: t.model });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
