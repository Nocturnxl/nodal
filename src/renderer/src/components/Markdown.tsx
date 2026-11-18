import { ExternalLink } from 'lucide-react';
import { Children, isValidElement, memo, useMemo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { relay } from '../lib/ipc';
import { splitBlocks } from '../lib/tree';
import { useStore } from '../store';
import { CopyButton } from './ui';

// Model output is untrusted. No raw-HTML plugin is installed, so tags in the
// text render as text. Links never navigate: main shows the full URL and asks
// first. Remote images are never fetched; they appear as a link instead.

function openLink(href: string | undefined) {
  if (href) void relay.app.openExternal(href).catch((e) => useStore.getState().toastError('Could not open the link', e));
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return '';
}

const components: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          openLink(href);
        }}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const url = typeof src === 'string' ? src : undefined;
    return (
      <button type="button" className="linkish inline-flex items-center gap-1" title={url} onClick={() => openLink(url)}>
        <ExternalLink size={12} />
        {alt?.trim() || 'image'} (remote image, not loaded)
      </button>
    );
  },
  pre({ children }) {
    const child = Children.toArray(children)[0];
    const className = isValidElement(child) ? ((child as ReactElement<{ className?: string }>).props.className ?? '') : '';
    const lang = /language-([\w+#.-]+)/.exec(className)?.[1];
    return (
      <div className="codeblock">
        <div className="flex h-8 items-center justify-between border-b border-line pr-1 pl-3 text-[11.5px] text-muted">
          <span className="font-mono">{lang ?? 'text'}</span>
          <CopyButton text={() => nodeText(children).replace(/\n$/, '')} label="Copy code" />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  // Task-list checkboxes are read-only; give each one a name for screen readers.
  input({ type, checked }) {
    if (type !== 'checkbox') return null;
    return <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? 'Done' : 'Not done'} />;
  },
  table({ children }) {
    return (
      <div className="tablewrap">
        <table>{children}</table>
      </div>
    );
  },
};

const Block = memo(function Block({ text, math }: { text: string; math: boolean }) {
  const remark = useMemo(() => (math ? [remarkGfm, remarkMath] : [remarkGfm]), [math]);
  const rehype = useMemo(
    () => (math ? [rehypeKatex, [rehypeHighlight, { detect: false, ignoreMissing: true }]] : [[rehypeHighlight, { detect: false, ignoreMissing: true }]]),
    [math],
  );
  return (
    <ReactMarkdown remarkPlugins={remark} rehypePlugins={rehype as never} components={components}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Finished messages render as one document. Streaming messages render block
 * by block, so only the last (still growing) block re-parses each frame.
 */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const math = useStore((s) => s.settings.mathEnabled);
  const blocks = useMemo(() => (streaming ? splitBlocks(text) : null), [streaming, text]);
  return (
    <div className="md">
      {blocks ? blocks.map((b, i) => <Block key={i} text={b} math={math} />) : <Block text={text} math={math} />}
    </div>
  );
});
