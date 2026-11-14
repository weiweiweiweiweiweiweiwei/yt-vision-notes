/* YT-Vision-Notes — AI notes with the Gemini API.
 * Gemini can watch a public YouTube video directly (picture + sound), so we send the video URL plus instructions
 * and ask for structured JSON: a summary and the key moments with timestamps. The extension then captures the
 * real frames at those timestamps itself.
 *
 * The API key is the user's own, stored only in chrome.storage.local on this computer (never synced or committed).
 */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});
  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const DEFAULT_MODEL = 'gemini-2.5-flash';

  const SCHEMA = {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING', description: 'Markdown summary of the whole video: the key takeaways as bullet points.' },
      sections: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            ts: { type: 'INTEGER', description: 'Start time of this moment in whole seconds from the beginning of the video.' },
            title: { type: 'STRING' },
            note: { type: 'STRING', description: 'What to remember, 1-3 short sentences, markdown allowed, no timestamps.' },
            screenshot: { type: 'BOOLEAN', description: 'True when the picture on screen at ts is worth keeping.' },
          },
          required: ['ts', 'title', 'note', 'screenshot'],
        },
      },
    },
    required: ['summary', 'sections'],
  };

  const MODES = {
    summary: 'Give me an overview of the video plus its key moments.',
    steps: 'This is a tutorial. Break it into the concrete steps I need to reproduce it, one section per step, in order.',
    custom: '',
  };

  YVN.aiSettings = async () => {
    const r = await chrome.storage.local.get(['geminiKey', 'geminiModel']);
    return { key: (r.geminiKey || '').trim(), model: (r.geminiModel || '').trim() || DEFAULT_MODEL };
  };

  /**
   * req = { videoId, title, mode: 'summary'|'steps'|'custom', instruction, language, maxShots }
   * → { summary, sections: [{ ts, title, note, screenshot }] }
   */
  YVN.geminiNotes = async (req) => {
    const { key, model } = await YVN.aiSettings();
    if (!key) throw new Error('Add your Gemini API key in the extension popup first (click the extension icon).');
    const lang = req.language === 'video' ? 'the same language as the video' : req.language || 'Traditional Chinese (繁體中文)';
    const prompt = [
      `You are taking study notes for me from this YouTube video${req.title ? ` titled "${req.title}"` : ''}.`,
      MODES[req.mode] || MODES.summary,
      `Write everything in ${lang}.`,
      'summary: a concise markdown summary of the whole video (3-8 bullet points of key takeaways).',
      'sections: the important moments in chronological order. ts must be the exact second where that moment starts on screen.',
      `Set screenshot to true only when the image itself is worth keeping (a settings panel, a menu, a diagram, a before/after, a finished result) — at most ${Math.max(0, req.maxShots | 0)} sections.`,
      'Keep titles short. Do not invent anything that is not in the video.',
      req.instruction ? `Extra instructions from me: ${req.instruction}` : '',
    ].filter(Boolean).join('\n');

    const body = {
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${req.videoId}` } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.3 },
    };
    let res;
    try {
      res = await fetch(`${ENDPOINT}${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('Could not reach the Gemini API (check your network).');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
      if (res.status === 400 && /API key/i.test(msg)) throw new Error('Gemini rejected the API key. Check it in the extension popup.');
      if (res.status === 429) throw new Error('Gemini quota or rate limit reached. Try again later.');
      if (/token/i.test(msg) && /exceed|limit|long/i.test(msg)) throw new Error('This video is too long for one request.');
      throw new Error('Gemini error: ' + msg);
    }
    const cand = data.candidates && data.candidates[0];
    if (!cand) throw new Error('Gemini returned no answer' + (data.promptFeedback && data.promptFeedback.blockReason ? ` (${data.promptFeedback.blockReason})` : '') + '.');
    const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
    let out;
    try { out = JSON.parse(text); } catch (e) { throw new Error('Gemini answered in an unexpected format. Try again.'); }
    out.summary = String(out.summary || '').trim();
    out.sections = (Array.isArray(out.sections) ? out.sections : [])
      .map((s) => ({ ts: Math.max(0, Math.round(+s.ts || 0)), title: String(s.title || '').trim(), note: String(s.note || '').trim(), screenshot: !!s.screenshot }))
      .filter((s) => s.title || s.note)
      .sort((a, b) => a.ts - b.ts);
    // respect the screenshot limit even if the model did not
    let n = 0;
    for (const s of out.sections) if (s.screenshot && ++n > (req.maxShots | 0)) s.screenshot = false;
    return out;
  };
})(typeof self !== 'undefined' ? self : globalThis);
