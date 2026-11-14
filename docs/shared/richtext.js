/* YT-Vision-Notes — WYSIWYG card editor (contenteditable) + floating format toolbar.
 * Text is still stored as Markdown (see markdown.js), so search, export and sync stay unchanged.
 *
 *   const ed = new YVN.RichEditor(markdown, { placeholder, onDone, onComment(id, spanEl) });
 *   card.append(ed.el); ed.focus();  …  ed.getMarkdown()
 *   const bar = new YVN.FormatBar(containerEl, { onComment(range) });  bar.attach(ed) / bar.detach()
 */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});
  const BLOCK = /^(p|div|h[1-6]|ul|ol|li|blockquote|pre|hr)$/i;

  // ---------- DOM → Markdown ----------
  function wrapM(m, s) {
    if (!s.trim()) return s;
    const a = s.match(/^\s*/)[0], b = s.match(/\s*$/)[0];
    return a + m + s.trim() + m + b;
  }
  function styleWrap(n, s) {
    const st = n.style || {};
    if (st.fontWeight === 'bold' || +st.fontWeight >= 600) s = wrapM('**', s);
    if (st.fontStyle === 'italic') s = wrapM('*', s);
    const td = (st.textDecorationLine || '') + ' ' + (st.textDecoration || '');
    if (/line-through/.test(td)) s = wrapM('~~', s);
    if (/underline/.test(td)) s = wrapM('++', s);
    return s;
  }
  function inlineMd(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/ /g, ' ').replace(/\n/g, ' '); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName.toLowerCase();
      if (t === 'br') { out += '\n'; continue; }
      if (t === 'input') continue;
      if (BLOCK.test(t)) { const s = inlineMd(n); out += (out && !out.endsWith('\n') ? '\n' : '') + s + '\n'; continue; }
      const inner = inlineMd(n);
      if (t === 'strong' || t === 'b') out += wrapM('**', inner);
      else if (t === 'em' || t === 'i') out += wrapM('*', inner);
      else if (t === 'del' || t === 's' || t === 'strike') out += wrapM('~~', inner);
      else if (t === 'u') out += wrapM('++', inner);
      else if (t === 'mark') out += wrapM('==', inner);
      else if (t === 'code') out += n.textContent ? '`' + n.textContent.replace(/`/g, '') + '`' : '';
      else if (t === 'a') {
        if (n.classList.contains('yvn-tag')) out += n.textContent;
        else if (n.classList.contains('yvn-wikilink')) out += '[[' + n.textContent + ']]';
        else if (n.classList.contains('yvn-ts')) out += '[' + n.textContent + ']';
        else {
          const href = n.getAttribute('href') || '';
          out += /^https?:\/\//.test(href) && inner.trim() ? `[${inner}](${href})` : inner;
        }
      } else if (t === 'span' && n.dataset && n.dataset.c) out += inner.trim() ? `[${inner}]{#${n.dataset.c}}` : inner;
      else out += styleWrap(n, inner);
    }
    return out;
  }
  function blockMd(root) {
    const out = [];
    let buf = null;
    const pushPara = (s, center) => {
      s = s.replace(/^\n+|\n+$/g, '');
      if (!s.trim()) return;
      out.push(center ? '->' + s + '<-' : s);
    };
    const flushBuf = () => { if (buf) { pushPara(inlineMd(buf)); buf = null; } };
    for (const n of root.childNodes) {
      const t = n.nodeType === 1 ? n.tagName.toLowerCase() : '#text';
      if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCK.test(t))) {
        if (!buf) buf = document.createElement('p');
        buf.appendChild(n.cloneNode(true));
        continue;
      }
      flushBuf();
      const center = n.style && n.style.textAlign === 'center';
      if (t === 'p') pushPara(inlineMd(n), center);
      else if (t === 'div') {
        if ([...n.children].some((c) => BLOCK.test(c.tagName))) { const inner = blockMd(n); if (inner) out.push(inner); }
        else pushPara(inlineMd(n), center);
      } else if (/^h[1-6]$/.test(t)) {
        const s = inlineMd(n).replace(/\n+/g, ' ').trim();
        if (s) out.push('#'.repeat(Math.max(1, +t[1] - 2)) + ' ' + (center ? '->' + s + '<-' : s));
      } else if (t === 'ul' || t === 'ol') {
        const lines = [];
        let k = 0;
        for (const li of n.children) {
          if (li.tagName !== 'LI') continue;
          k++;
          const cb = li.querySelector('input[type=checkbox]');
          const s = inlineMd(li).replace(/\n+/g, ' ').trim();
          if (!s && !cb) continue;
          lines.push((t === 'ol' ? k + '. ' : '- ') + (cb ? `[${cb.checked ? 'x' : ' '}] ` : '') + s);
        }
        if (lines.length) out.push(lines.join('\n'));
      } else if (t === 'blockquote') {
        const s = inlineMd(n).replace(/\n+$/, '');
        if (s.trim()) out.push(s.split('\n').map((l) => '> ' + l).join('\n'));
      } else if (t === 'pre') out.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```');
      else if (t === 'hr') out.push('---');
      else if (t === 'li') pushPara(inlineMd(n));
    }
    flushBuf();
    return out.join('\n\n');
  }
  YVN.htmlToMarkdown = blockMd;

  const closest = (node, sel, root) => {
    let n = node && (node.nodeType === 1 ? node : node.parentElement);
    while (n && n !== root) { if (n.matches && n.matches(sel)) return n; n = n.parentElement; }
    return null;
  };
  function unwrap(elm) {
    const p = elm.parentNode;
    while (elm.firstChild) p.insertBefore(elm.firstChild, elm);
    p.removeChild(elm);
    p.normalize();
  }
  function selectNode(n) {
    const r = document.createRange();
    r.selectNodeContents(n);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  // ---------- editor ----------
  class RichEditor {
    constructor(md, o) {
      this.o = o || {};
      const el = (this.el = document.createElement('div'));
      el.className = 'yb-rt yvn-md';
      el.contentEditable = 'true';
      el.spellcheck = false;
      el.dataset.placeholder = this.o.placeholder || '';
      YVN.setHTML(el, YVN.renderMarkdown(md || '') || '<p><br></p>');
      for (const cb of el.querySelectorAll('input[type=checkbox]')) cb.contentEditable = 'false';
      this._empty();
      el.addEventListener('input', (e) => {
        this._empty();
        // run after the current edit finishes (execCommand cannot be nested inside another one)
        if (e.inputType === 'insertText' && e.data === ' ') setTimeout(() => { this._shortcuts(e); this._empty(); }, 0);
      });
      el.addEventListener('keydown', (e) => this._key(e));
      el.addEventListener('paste', (e) => {
        e.preventDefault(); e.stopPropagation();
        const t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        document.execCommand('insertText', false, t);
      });
      el.addEventListener('focus', () => {
        try { document.execCommand('defaultParagraphSeparator', false, 'p'); document.execCommand('styleWithCSS', false, false); } catch (err) { /* old browsers */ }
      });
    }
    _empty() { this.el.classList.toggle('yb-rt-empty', !this.el.textContent.trim() && !this.el.querySelector('li, input, hr')); }
    focus(atEnd) {
      this.el.focus();
      if (atEnd !== false) {
        const r = document.createRange();
        r.selectNodeContents(this.el); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    }
    getMarkdown() { return blockMd(this.el); }

    _key(e) {
      e.stopPropagation(); // keep board / YouTube shortcuts out while typing
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && !e.shiftKey && !mod) {
        const s0 = getSelection();
        const from = s0.rangeCount ? closest(s0.anchorNode, 'li.yvn-task', this.el) : null;
        if (from) setTimeout(() => {
          const li = closest(getSelection().anchorNode, 'li', this.el);
          if (!li || li === from || li.querySelector('input[type=checkbox]')) return;
          li.classList.add('yvn-task');
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.contentEditable = 'false';
          li.prepend(cb, document.createTextNode(' '));
        }, 0);
      }
      if (e.key === 'Escape' || (e.key === 'Enter' && mod)) { e.preventDefault(); if (this.o.onDone) this.o.onDone(); return; }
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); if (this.bar) this.bar.linkMode(); }
      else if (k === 'x' && e.shiftKey) { e.preventDefault(); this.cmd('strike'); }
      else if (k === 'e') { e.preventDefault(); this.cmd('code'); }
      else if (k === 'u') { e.preventDefault(); this.cmd('underline'); }
    }

    /** "- " / "* " / "1. " / "[] " at the start of a line become lists. */
    _shortcuts(e) {
      if (e.inputType !== 'insertText' || e.data !== ' ') return;
      const s = getSelection();
      if (!s.rangeCount) return;
      const node = s.anchorNode;
      if (!node || node.nodeType !== 3) return;
      const block = closest(node, 'p, div, li', this.el) || this.el;
      if (block.tagName === 'LI') return;
      const txt = block.textContent.replace(/ /g, ' ');
      const m = /^(-|\*|1\.|\[\])\s$/.exec(txt);
      if (!m) return;
      node.nodeValue = node.nodeValue.replace(/^\s*(-|\*|1\.|\[\])[\s ]/, '');
      if (m[1] === '1.') document.execCommand('insertOrderedList');
      else {
        document.execCommand('insertUnorderedList');
        if (m[1] === '[]') {
          const li = closest(getSelection().anchorNode, 'li', this.el);
          if (li) {
            li.classList.add('yvn-task');
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.contentEditable = 'false';
            li.prepend(cb, document.createTextNode(' '));
          }
        }
      }
    }

    range() {
      const s = getSelection();
      if (!s.rangeCount) return null;
      const r = s.getRangeAt(0);
      return this.el.contains(r.commonAncestorContainer) ? r : null;
    }
    state() {
      const r = this.range();
      const q = (c) => { try { return document.queryCommandState(c); } catch (e) { return false; } };
      return {
        bold: q('bold'), italic: q('italic'), strike: q('strikeThrough'), underline: q('underline'),
        ul: q('insertUnorderedList'), ol: q('insertOrderedList'), center: q('justifyCenter'),
        code: !!(r && closest(r.startContainer, 'code', this.el)),
        link: !!(r && closest(r.startContainer, 'a[href^="http"]', this.el)),
        comment: !!(r && closest(r.startContainer, 'span.yvn-cmt', this.el)),
      };
    }
    cmd(name, arg) {
      const r = this.range();
      if (!r) return;
      const st = this.state();
      switch (name) {
        case 'bold': document.execCommand('bold'); break;
        case 'italic': document.execCommand('italic'); break;
        case 'strike': document.execCommand('strikeThrough'); break;
        case 'underline': document.execCommand('underline'); break;
        case 'ul': document.execCommand('insertUnorderedList'); break;
        case 'ol': document.execCommand('insertOrderedList'); break;
        case 'center': document.execCommand(st.center ? 'justifyLeft' : 'justifyCenter'); break;
        case 'code': {
          const c = closest(r.startContainer, 'code', this.el);
          if (c) { unwrap(c); break; }
          if (r.collapsed) break;
          const code = document.createElement('code');
          code.textContent = r.toString();
          r.deleteContents(); r.insertNode(code); selectNode(code);
          break;
        }
        case 'link': {
          const a = closest(r.startContainer, 'a', this.el);
          if (!arg) { if (a) unwrap(a); break; }
          if (a) { a.href = arg; break; }
          if (r.collapsed) break;
          document.execCommand('createLink', false, arg);
          break;
        }
        case 'comment': {
          const existing = closest(r.startContainer, 'span.yvn-cmt', this.el);
          if (existing) { if (this.o.onComment) this.o.onComment(existing.dataset.c, existing, false); break; }
          if (r.collapsed) break;
          const span = document.createElement('span');
          span.className = 'yvn-cmt';
          span.dataset.c = YVN.uid('c_');
          span.appendChild(r.extractContents());
          r.insertNode(span);
          selectNode(span);
          if (this.o.onComment) this.o.onComment(span.dataset.c, span, true);
          break;
        }
      }
      this._empty();
      if (this.bar) this.bar.update();
    }
  }
  YVN.RichEditor = RichEditor;
  YVN.unwrapEl = unwrap;

  // ---------- floating format toolbar ----------
  const B = [
    ['bold', '<b>B</b>', 'Bold (Ctrl+B)'],
    ['italic', '<i>I</i>', 'Italic (Ctrl+I)'],
    ['strike', '<s>S</s>', 'Strikethrough (Ctrl+Shift+X)'],
    ['underline', '<u>U</u>', 'Underline (Ctrl+U)'],
    ['|'],
    ['ul', '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="7" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="17" r="1" fill="currentColor"/><path d="M9 7h11M9 12h11M9 17h11"/></svg>', 'Bulleted list (type "- " at line start)'],
    ['ol', '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 7h10M10 12h10M10 17h10"/><text x="2.5" y="9" font-size="7" fill="currentColor" stroke="none">1</text><text x="2.5" y="14.5" font-size="7" fill="currentColor" stroke="none">2</text><text x="2.5" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg>', 'Numbered list (type "1. " at line start)'],
    ['center', '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M7 10h10M4 14h16M7 18h10"/></svg>', 'Align center'],
    ['code', '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>', 'Inline code (Ctrl+E)'],
    ['|'],
    ['link', '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>', 'Link (Ctrl+K)'],
    ['comment', '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H10l-4 4v-4H4z"/></svg>', 'Add comment'],
  ];

  class FormatBar {
    constructor(container) {
      this.container = container;
      this.ed = null;
      const el = (this.el = document.createElement('div'));
      el.className = 'yb-fmt';
      el.hidden = true;
      this.btns = document.createElement('div');
      this.btns.className = 'yb-fmt-btns';
      for (const [cmd, html, title] of B) {
        if (cmd === '|') { const s = document.createElement('i'); s.className = 'yb-fmt-sep'; this.btns.append(s); continue; }
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.cmd = cmd; b.title = title; b.setAttribute('aria-label', title);
        YVN.setHTML(b, html);
        this.btns.append(b);
      }
      this.linkBox = document.createElement('div');
      this.linkBox.className = 'yb-fmt-link';
      this.linkBox.hidden = true;
      this.linkInput = document.createElement('input');
      this.linkInput.type = 'url'; this.linkInput.placeholder = 'Paste a link and press Enter';
      this.unlinkBtn = document.createElement('button');
      this.unlinkBtn.type = 'button'; this.unlinkBtn.textContent = 'Remove';
      this.linkBox.append(this.linkInput, this.unlinkBtn);
      el.append(this.btns, this.linkBox);
      container.append(el);

      // keep the text selection when pressing toolbar buttons
      el.addEventListener('mousedown', (e) => { if (e.target !== this.linkInput) e.preventDefault(); });
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.btns.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || !this.ed) return;
        if (b.dataset.cmd === 'link') return this.linkMode();
        this.ed.cmd(b.dataset.cmd);
      });
      this.linkInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); this.applyLink(this.linkInput.value.trim()); }
        if (e.key === 'Escape') { e.preventDefault(); this.applyLink(null); }
      });
      this.unlinkBtn.addEventListener('click', () => this.applyLink(''));
      this._onSel = () => this.update();
      document.addEventListener('selectionchange', this._onSel);
    }
    attach(ed) { this.ed = ed; ed.bar = this; this.update(); }
    detach() { if (this.ed) this.ed.bar = null; this.ed = null; this._linkRange = null; this.linkBox.hidden = true; this.btns.hidden = false; this.el.hidden = true; }
    isBusy() { return !!this._linkRange || this.el.contains(document.activeElement); }

    update() {
      if (!this.ed || this._linkRange) return;
      const r = this.ed.range();
      if (!r || r.collapsed) { this.el.hidden = true; return; }
      const st = this.ed.state();
      for (const b of this.btns.querySelectorAll('button')) b.classList.toggle('on', !!st[b.dataset.cmd]);
      this.el.hidden = false;
      this._place(r.getBoundingClientRect());
    }
    _place(rect) {
      const cr = this.container.getBoundingClientRect();
      const w = this.el.offsetWidth, h = this.el.offsetHeight;
      let left = rect.left + rect.width / 2 - cr.left - w / 2;
      left = Math.max(4, Math.min(left, cr.width - w - 4));
      let top = rect.top - cr.top - h - 8;
      if (top < 4) top = rect.bottom - cr.top + 8;
      this.el.style.left = left + 'px'; this.el.style.top = top + 'px';
    }
    linkMode() {
      const r = this.ed && this.ed.range();
      if (!r) return;
      const a = closest(r.startContainer, 'a[href^="http"]', this.ed.el);
      if (r.collapsed && !a) return;
      this._linkRange = r.cloneRange();
      this.linkInput.value = a ? a.getAttribute('href') : '';
      this.unlinkBtn.hidden = !a;
      this.btns.hidden = true; this.linkBox.hidden = false; this.el.hidden = false;
      this._place(r.getBoundingClientRect());
      this.linkInput.focus(); this.linkInput.select();
    }
    applyLink(url) {
      const r = this._linkRange;
      this._linkRange = null;
      this.linkBox.hidden = true; this.btns.hidden = false;
      if (!this.ed || !r) return;
      this.ed.el.focus();
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      if (url === null) { this.update(); return; }
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      this.ed.cmd('link', url);
    }
    destroy() { document.removeEventListener('selectionchange', this._onSel); this.el.remove(); }
  }
  YVN.FormatBar = FormatBar;
})(typeof self !== 'undefined' ? self : globalThis);
