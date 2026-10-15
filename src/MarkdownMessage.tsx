import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from './icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock({ children, onError }: { children: ReactNode; onError(error: unknown): void }) {
  const [copied, setCopied] = useState(false);
  const block = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const language = isValidElement<{ className?: string }>(children)
    ? /language-([\w+#.-]+)/.exec(children.props.className || '')?.[1]
    : undefined;
  return (
    <div className="chat-code" ref={block}>
      <div className="chat-code-header">
        <span>{language || 'Code'}</span>
        <button
          type="button"
          className="text-button"
          aria-label="Copy code"
          onClick={() => {
            const code = block.current?.querySelector('code');
            navigator.clipboard
              .writeText(code?.textContent || '')
              .then(() => setCopied(true))
              .catch(onError);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownMessage({
  content,
  onError,
}: {
  content: string;
  onError(error: unknown): void;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <CodeBlock onError={onError}>{children}</CodeBlock>,
        table: ({ children }) => (
          <div className="chat-table">
            <table>{children}</table>
          </div>
        ),
        a: ({ href, children }) => {
          if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
          return (
            <a
              href={href}
              title="Open in your browser"
              onClick={(event) => {
                event.preventDefault();
                window.workspace!.openExternal(href).catch(onError);
              }}
            >
              {children}
            </a>
          );
        },
        img: ({ alt }) => <span className="muted">[Image: {alt || 'attachment'}]</span>,
      }}
    >
      {content}
    </Markdown>
  );
}

export default memo(MarkdownMessage);
