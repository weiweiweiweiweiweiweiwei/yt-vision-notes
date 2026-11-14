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
  const FALLBACK_MODEL = 'gemini-2.5-flash'; // only used when the model list cannot be fetched

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

  // ---------- models: ask Google which ones this key can use, pick the strongest ----------
  const SKIP = /(embed|tts|image|live|audio|aqa|robotics|computer-use|native|learnlm|gemma|nano)/i;
  /** Higher = stronger: newer version first, then Pro > Flash > Flash-Lite, stable over preview. */
  YVN.geminiRank = (id) => {
    const v = /gemini-(\d+(?:\.\d+)?)/i.exec(id);
    if (!v) return -1;
    let score = parseFloat(v[1]) * 100;
    if (/-pro(?:-|$)/i.test(id)) score += 30;
    else if (/lite/i.test(id)) score += 0;
    else if (/flash/i.test(id)) score += 20;
    if (/preview|exp|latest/i.test(id)) score -= 5;
    return score;
  };
  /** [{ id, label }] of models that can generate content, strongest first. */
  YVN.geminiModels = async (key) => {
    const out = [];
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, { headers: { 'x-goog-api-key': key } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data.error && data.error.message) || `HTTP ${r.status}`);
      for (const m of data.models || []) {
        const id = String(m.name || '').replace(/^models\//, '');
        if (!/^gemini/i.test(id) || SKIP.test(id)) continue;
        if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
        out.push({ id, label: m.displayName || id });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return out.sort((a, b) => YVN.geminiRank(b.id) - YVN.geminiRank(a.id) || a.id.localeCompare(b.id));
  };
  YVN.bestGeminiModel = async (key) => {
    const list = await YVN.geminiModels(key);
    return list.length ? list[0].id : FALLBACK_MODEL;
  };

  YVN.aiSettings = async () => {
    const r = await chrome.storage.local.get(['geminiKey', 'geminiModel']);
    const key = (r.geminiKey || '').trim();
    let model = (r.geminiModel || '').trim().replace(/^models\//, '');
    if (key && !/^gemini[\w.-]*$/i.test(model)) { // nothing picked yet (or something that isn't a model id)
      try { model = await YVN.bestGeminiModel(key); await chrome.storage.local.set({ geminiModel: model }); } catch (e) { model = FALLBACK_MODEL; }
    }
    return { key, model: model || FALLBACK_MODEL };
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
    const call = async (m) => {
      let r;
      try {
        r = await fetch(`${ENDPOINT}${encodeURIComponent(m)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new Error('Could not reach the Gemini API (check your network).');
      }
      return { res: r, data: await r.json().catch(() => ({})) };
    };
    let { res, data } = await call(model);
    // the chosen model was retired or renamed: switch to the strongest model available now and retry once
    const modelGone = (r, d) => !r.ok && (r.status === 404 || /no longer available|model name|not found|not supported for generateContent|is not available/i.test((d.error && d.error.message) || ''));
    if (modelGone(res, data)) {
      const best = await YVN.bestGeminiModel(key).catch(() => null);
      if (best && best !== model) {
        await chrome.storage.local.set({ geminiModel: best });
        ({ res, data } = await call(best));
      }
    }
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
