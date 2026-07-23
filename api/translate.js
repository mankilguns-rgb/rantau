// Rantau 번역 서버 함수 (Vercel Serverless)
// 키는 Vercel 환경변수 GEMINI_API_KEY 에만 저장 — 브라우저에 노출되지 않음
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return; }

  const { texts, target } = req.body || {};
  if (!Array.isArray(texts) || !texts.length || !target) {
    res.status(400).json({ error: 'need { texts: [..], target: "ko|en|zh|ja|id" }' }); return;
  }

  const names = { ko: 'Korean', en: 'English', zh: 'Simplified Chinese', ja: 'Japanese', id: 'Indonesian' };
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const list = texts.slice(0, 50).map(s => String(s).slice(0, 2000));
  const prompt =
    'Translate every item of this JSON array into ' + (names[target] || target) + '.\n' +
    'These are casual secondhand-marketplace listings and chat messages — translate naturally and colloquially, keep emojis, numbers and proper nouns as-is.\n' +
    'Return ONLY a JSON array of translated strings, same length and order.\n' +
    JSON.stringify(list);

  try {
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
    if (!r.ok) { res.status(502).json({ error: 'upstream ' + r.status }); return; }
    const d = await r.json();
    let out;
    try { out = JSON.parse(d.candidates[0].content.parts[0].text); }
    catch (e) { res.status(502).json({ error: 'parse failed' }); return; }
    if (!Array.isArray(out)) { res.status(502).json({ error: 'bad shape' }); return; }
    res.status(200).json({ translations: out.map(String) });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
