/**
 * Markdown for model output. Everything goes through DOMPurify: this window can approve agent
 * actions, so model-written HTML must never execute.
 */
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked } from 'marked';

for (const [name, lang] of Object.entries({ bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['rs'], { languageName: 'rust' });

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function highlight(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    if (code.length < 12_000) return hljs.highlightAuto(code).value;
  } catch {
    /* fall through */
  }
  return esc(code);
}

/** Marks the Copy buttons this renderer makes: one a model writes in raw HTML could copy hidden text. */
let copyMark = '';

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? '').split(/\s/)[0];
      return `<div class="codeblock"><div class="codeblock-head"><span>${esc(l)}</span><button type="button" class="copy" data-copy="${copyMark}">Copy</button></div><pre><code class="hljs">${highlight(text, l)}</code></pre></div>`;
    },
  },
});

// Classes this renderer produces itself: highlight.js scopes, the code block chrome, file refs. A
// class a model writes could borrow the app's own styles (a full-window overlay, a toast), so it goes.
const OWN_CLASS = /^(hljs(-[\w-]+)?|[a-z]+_+|language-[\w+-]+|codeblock|codeblock-head|copy|ref)$/;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const cls = node.getAttribute('class');
  if (cls !== null) {
    const kept = cls.split(/\s+/).filter((c) => OWN_CLASS.test(c));
    if (kept.length) node.setAttribute('class', kept.join(' '));
    else node.removeAttribute('class');
  }
  if (node.hasAttribute('data-copy') && node.getAttribute('data-copy') !== copyMark) node.removeAttribute('data-copy');
  // Only real pages, on any element (SVG links and image-map areas too): a relative or #fragment link
  // would move the app window itself.
  for (const a of ['href', 'xlink:href']) {
    const v = node.getAttribute(a);
    if (v !== null && !/^(https?:|mailto:)/i.test(v)) node.removeAttribute(a);
  }
  const tag = node.nodeName.toLowerCase();
  if (tag !== 'a' && tag !== 'area') return;
  if (!node.hasAttribute('href') && !node.hasAttribute('xlink:href')) {
    // Models often "link" file references (stats.py:2-4); those are not pages, so keep them as text.
    node.setAttribute('class', 'ref');
    return;
  }
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
});

export function renderMarkdown(src: string): string {
  copyMark = crypto.randomUUID();
  const html = marked.parse(src, { async: false }) as string;
  // No style sheets, inline styles, forms or popovers from model output: they could restyle or cover
  // the app, including the card that asks before an agent runs a command.
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-copy', 'target'], FORBID_TAGS: ['style', 'form', 'dialog'], FORBID_ATTR: ['style', 'popover', 'popovertarget', 'popovertargetaction'] });
}

/** One delegated handler for every Copy button inside rendered markdown. */
export function onCopyClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest('[data-copy]');
  if (!btn) return;
  const code = btn.closest('.codeblock')?.querySelector(':scope > pre > code')?.textContent ?? '';
  void navigator.clipboard.writeText(code);
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = 'Copy'), 1200);
}
