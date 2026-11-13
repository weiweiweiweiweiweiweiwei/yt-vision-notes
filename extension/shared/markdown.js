/* YT-Vision-Notes — tiny safe Markdown renderer.
 * Supports: headings, bold/italic/strike, inline code, fenced code, lists, task lists, blockquote,
 * links, hr, #tags, [[wikilinks]] and [mm:ss] timestamps. All text is HTML-escaped first.
 * Extensions used by the rich-text editor: ++underline++, ->centered paragraph<-, [text]{#c_id} comment marks. */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});
  const esc = (s) => YVN.escapeHtml(s);

  function tsToSec(str) {
    const p = str.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  }

  function inline(src) {
    const codes = [];
    let s = src.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\{#(c_[\w-]+)\}/g, '<span class="yvn-cmt" data-c="$2">$1</span>');
    s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t) => `<a class="yvn-wikilink" data-wikilink="${t}" href="#/search/${encodeURIComponent(t.replace(/&amp;/g, '&'))}">${t}</a>`);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, t) => `<a class="yvn-ts" data-ts="${tsToSec(t)}" href="#">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\+\+([^+]+)\+\+/g, '<u>$1</u>');
    s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
    s = s.replace(/(^|[\s(（])#([\p{L}\p{N}_\-]+)/gu, '$1<a class="yvn-tag" data-tag="$2" href="#/tag/$2">#$2</a>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
    return s;
  }

  /** Flip the n-th "- [ ]" task in markdown text. */
  YVN.toggleTask = function (md, n) {
    let k = -1;
    return String(md || '').replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/gm, (all, pre, mark) => (++k === n ? `${pre}[${mark === ' ' ? 'x' : ' '}]` : all));
  };

  function centered(t) {
    const m = /^->([\s\S]*)<-\s*$/.exec(t);
    return m ? { text: m[1] } : null;
  }

  YVN.renderMarkdown = function (md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0, para = [], taskN = 0;
    const flush = () => {
      if (!para.length) return;
      const c = centered(para.join('\n'));
      out.push(`<p${c ? ' style="text-align:center"' : ''}>${(c ? c.text.split('\n') : para).map(inline).join('<br>')}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^```/.test(line)) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush();
        const lv = Math.min(6, m[1].length + 2); // keep headings small inside note cards
        const c = centered(m[2]);
        out.push(`<h${lv}${c ? ' style="text-align:center"' : ''}>${inline(c ? c.text : m[2])}</h${lv}>`);
        i++; continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          let t = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          const task = /^\[([ xX])\]\s+/.exec(t);
          if (task) {
            t = t.slice(task[0].length);
            items.push(`<li class="yvn-task"><input type="checkbox" data-task="${taskN++}"${task[1] === ' ' ? '' : ' checked'}> ${inline(t)}</li>`);
          } else items.push(`<li>${inline(t)}</li>`);
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  };
})(typeof self !== 'undefined' ? self : globalThis);
