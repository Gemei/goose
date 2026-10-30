import React, {
  memo,
  useCallback,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
// Improved oneDark theme for better comment contrast and readability
const customOneDarkTheme = {
  ...oneDark,
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    color: '#e6e6e6',
    fontSize: '14px',
  },
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    color: '#e6e6e6',
    fontSize: '14px',
  },
  comment: { ...oneDark.comment, color: '#a0a0a0', fontStyle: 'italic' },
  prolog: { ...oneDark.prolog, color: '#a0a0a0', fontStyle: 'italic' },
  doctype: { ...oneDark.doctype, color: '#a0a0a0' },
  cdata: { ...oneDark.cdata, color: '#a0a0a0' },
};

import { Check, Copy } from './icons';
import { wrapHTMLInCodeBlock } from '../utils/htmlSecurity';
import { BLOCKED_PROTOCOLS } from '../utils/urlSecurity';
import { getTextDirection } from '../utils/textDirection';
import { defineMessages, useIntl } from '../i18n';
import { splitMarkdownBlocks } from '../utils/markdownBlocks';
import { hashString, LruCache } from '../utils/markdownCache';

const i18n = defineMessages({
  copyCode: {
    id: 'markdownContent.copyCode',
    defaultMessage: 'Copy code',
  },
  failedToOpenLink: {
    id: 'markdownContent.failedToOpenLink',
    defaultMessage: 'Failed to Open Link',
  },
  noApplicationFound: {
    id: 'markdownContent.noApplicationFound',
    defaultMessage: 'No application found to open a link.',
  },
});

interface CodeProps extends React.ClassAttributes<HTMLElement>, React.HTMLAttributes<HTMLElement> {
  inline?: boolean;
}

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Minimal hast node shape; avoids importing @types/hast just for this plugin.
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown> | null;
  children?: HastNode[];
}

// Block-level elements that get their own computed dir so mixed-direction
// markdown (e.g. an English paragraph inside an Arabic message) resolves
// punctuation placement per block instead of inheriting the message direction.
const DIRECTIONAL_BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'dd',
  'dt',
  'td',
  'th',
  'figcaption',
  'caption',
  'summary',
]);

function collectText(node: HastNode): string {
  // Code and KaTeX output are language-neutral (both render LTR internally),
  // so they don't vote on the direction of the prose block containing them.
  if (node.type === 'element') {
    if (node.tagName === 'code' || node.tagName === 'pre') return '';
    const classNames = node.properties?.className;
    if (Array.isArray(classNames) && classNames.includes('katex')) return '';
  }
  let text = node.type === 'text' ? (node.value ?? '') : '';
  for (const child of node.children ?? []) {
    // Nested blocks other than paragraphs compute their own direction and
    // don't vote on the parent, so a long sublist can't flip the list item
    // containing it. Prose <p> children still count: loose list items and
    // blockquotes hold their own text in direct <p> children, and their
    // marker/indent side follows the parent's own direction.
    if (
      child.type === 'element' &&
      child.tagName &&
      child.tagName !== 'p' &&
      DIRECTIONAL_BLOCK_TAGS.has(child.tagName)
    ) {
      continue;
    }
    text += collectText(child);
  }
  return text;
}

function applyPerBlockDirection(node: HastNode): void {
  if (node.type === 'element' && node.tagName && DIRECTIONAL_BLOCK_TAGS.has(node.tagName)) {
    const direction = getTextDirection(collectText(node));
    if (direction) {
      node.properties = { ...node.properties, dir: direction };
    }
  }
  for (const child of node.children ?? []) {
    applyPerBlockDirection(child);
  }
}

function rehypePerBlockDirection(): (tree: HastNode) => void {
  return (tree) => {
    if (tree) applyPerBlockDirection(tree);
  };
}

// Very large code blocks exceed the value of coloring every character on the
// main thread; beyond the cap they render as plain monospace until they stop
// growing (nearly always only while a code block streams in).
const SYNTAX_HIGHLIGHT_MAX_CHARS = 50_000;

export const highlightHtmlCache = new LruCache<string>(120, 4_000_000);

// While a long chat's history is hydrating, every CodeBlock would otherwise
// run the full highlighter synchronously during mount, which dominates the
// time to first usable view. When the context is true, code renders as plain
// monospace first and the highlighter runs from a serial idle queue, so the
// history drain stays cheap and highlighting never bursts.
export const DeferHighlightContext = createContext(false);

const pendingHighlightJobs: (() => void)[] = [];
let highlightJobScheduled = false;

function processNextHighlightJob(): void {
  highlightJobScheduled = false;
  const job = pendingHighlightJobs.shift();
  if (!job) return;
  job();
  if (pendingHighlightJobs.length > 0) scheduleNextHighlightJob();
}

function scheduleNextHighlightJob(): void {
  if (highlightJobScheduled) return;
  highlightJobScheduled = true;
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(processNextHighlightJob, { timeout: 300 });
  } else {
    window.setTimeout(processNextHighlightJob, 50);
  }
}

// Memoized CodeBlock component to prevent re-rendering when props haven't changed
const CodeBlock = memo(function CodeBlock({
  language,
  children,
}: {
  language: string;
  children: string;
}) {
  const intl = useIntl();
  const deferHighlight = useContext(DeferHighlightContext);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const cacheKey = useMemo(() => hashString(`${language}\u0000${children}`), [children, language]);
  const [cacheState, setCacheState] = useState<{ key: string; html: string } | null>(() => {
    const html = highlightHtmlCache.get(cacheKey);
    return html !== undefined ? { key: cacheKey, html } : null;
  });
  const highlighterRef = useRef<HTMLDivElement | null>(null);

  const cachedHtml = cacheState !== null && cacheState.key === cacheKey ? cacheState.html : null;
  const canHighlight = children.length <= SYNTAX_HIGHLIGHT_MAX_CHARS;
  const [deferred, setDeferred] = useState(
    () => deferHighlight && cachedHtml === null && canHighlight
  );

  useEffect(() => {
    if (!deferHighlight) {
      if (deferred) setDeferred(false);
      return;
    }
    if (!deferred) return;
    let cancelled = false;
    pendingHighlightJobs.push(() => {
      if (!cancelled) setDeferred(false);
    });
    scheduleNextHighlightJob();
    return () => {
      cancelled = true;
    };
  }, [deferHighlight, deferred]);

  // Capture the highlighted markup once with a content-hash key, so any later
  // mount of the same code (returning to the chat after a session switch)
  // renders it verbatim instead of re-running the highlighter.
  useLayoutEffect(() => {
    if (cachedHtml !== null || !canHighlight || deferred) return;
    const container = highlighterRef.current;
    if (!container) return;
    const html = container.innerHTML;
    highlightHtmlCache.put(cacheKey, html, html.length);
    setCacheState({ key: cacheKey, html });
  }, [cacheKey, canHighlight, cachedHtml, deferred]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);

      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Memoize the SyntaxHighlighter component to prevent re-rendering
  // Only re-render if language or children change. Oversized code (>cap)
  // never reaches this path — it renders as plain monospace instead.
  const memoizedSyntaxHighlighter = useMemo(() => {
    return (
      <SyntaxHighlighter
        style={customOneDarkTheme}
        language={language}
        PreTag="div"
        customStyle={{
          background: 'var(--code-block-background, #282c34)',
          margin: 0,
          width: '100%',
          maxWidth: '100%',
        }}
        codeTagProps={{
          style: {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            overflowWrap: 'break-word',
            fontFamily: 'var(--font-mono)',
            fontSize: '14px',
          },
        }}
        // Performance optimizations for SyntaxHighlighter
        showLineNumbers={false} // Disable line numbers for better performance
        wrapLines={false} // Disable line wrapping for better performance
        lineProps={undefined} // Don't add extra props to each line
      >
        {children}
      </SyntaxHighlighter>
    );
  }, [children, language]);

  return (
    <div className="relative group w-full" dir="ltr">
      <button
        onClick={handleCopy}
        className="absolute right-2 bottom-2 p-1.5 rounded-lg bg-gray-700/50 text-gray-300 font-sans text-sm
                 opacity-0 group-hover:opacity-100 transition-opacity duration-200
                 hover:bg-gray-600/50 hover:text-gray-100 z-10"
        title={intl.formatMessage(i18n.copyCode)}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
      <div className="w-full overflow-x-auto" ref={highlighterRef}>
        {cachedHtml !== null ? (
          <div dangerouslySetInnerHTML={{ __html: cachedHtml }} />
        ) : canHighlight && !deferred ? (
          memoizedSyntaxHighlighter
        ) : (
          <code
            dir="ltr"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'var(--font-mono)',
              fontSize: '14px',
            }}
          >
            {children}
          </code>
        )}
      </div>
    </div>
  );
});

const MarkdownCode = memo(
  React.forwardRef(function MarkdownCode(
    { inline, className, children, ...props }: CodeProps,
    ref: React.Ref<HTMLElement>
  ) {
    const match = /language-(\w+)/.exec(className || '');
    const codeContent = String(children ?? '');

    // react-markdown gives untagged fenced blocks no language-xxx className,
    // so they look like inline code here. Block-level content always ends with
    // a trailing newline, which inline code spans can never contain.
    const isBlockLevelCode = !inline && codeContent.endsWith('\n');

    return isBlockLevelCode ? (
      <CodeBlock language={match ? match[1] : 'text'}>{codeContent.replace(/\n$/, '')}</CodeBlock>
    ) : (
      <code
        ref={ref}
        {...props}
        dir="ltr"
        className="break-all bg-inline-code whitespace-pre-wrap font-mono"
      >
        {children}
      </code>
    );
  })
);

// Custom URL transform to preserve deep link URLs (spotify:, vscode:, slack:, etc.)
// React-markdown's default only allows http/https/mailto and strips all other protocols
// We allow all protocols except dangerous ones (javascript:, data:, file:, etc.)
const customUrlTransform = (url: string): string => {
  try {
    const protocol = new URL(url).protocol;
    if (BLOCKED_PROTOCOLS.includes(protocol)) {
      return '';
    }
  } catch {
    // Not a valid URL, allow it (could be relative path)
  }
  return url;
};

const MarkdownPipeline = memo(function MarkdownPipeline({ content }: { content: string }) {
  const intl = useIntl();
  const processedContent = useMemo(() => {
    try {
      return wrapHTMLInCodeBlock(content);
    } catch (error) {
      console.error('Error processing content:', error);
      return content;
    }
  }, [content]);

  const handleOpenExternal = useCallback(
    async (href: string) => {
      try {
        await window.electron.openExternal(href);
      } catch {
        await window.electron.showMessageBox({
          type: 'error',
          buttons: ['OK'],
          title: intl.formatMessage(i18n.failedToOpenLink),
          message: intl.formatMessage(i18n.noApplicationFound),
          detail: href,
        });
      }
    },
    [intl]
  );

  return (
    <ReactMarkdown
      urlTransform={customUrlTransform}
      remarkPlugins={[remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[
        [
          rehypeKatex,
          {
            throwOnError: false,
            errorColor: '#cc0000',
            strict: false,
          },
        ],
        rehypePerBlockDirection,
      ]}
      components={{
        a: (props) => {
          return (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!props.href) return;

                void handleOpenExternal(props.href);
              }}
            />
          );
        },
        code: MarkdownCode,
      }}
    >
      {processedContent}
    </ReactMarkdown>
  );
});

const MarkdownContent = memo(function MarkdownContent({
  content,
  className = '',
}: MarkdownContentProps) {
  return (
    <div
      className={`w-full overflow-x-hidden prose prose-sm text-start text-text-primary dark:prose-invert max-w-full word-break font-sans
        prose-pre:p-0 prose-pre:m-0 !p-0
        prose-code:break-all prose-code:whitespace-pre-wrap prose-code:font-mono
        prose-a:break-all prose-a:overflow-wrap-anywhere
        prose-table:table prose-table:w-full
        prose-blockquote:text-inherit
        prose-td:border prose-td:border-border-primary prose-td:p-2
        prose-th:border prose-th:border-border-primary prose-th:p-2
        prose-thead:bg-background-primary
        prose-h1:text-2xl prose-h1:font-normal prose-h1:mb-5 prose-h1:mt-0 prose-h1:font-sans
        prose-h2:text-xl prose-h2:font-normal prose-h2:mb-4 prose-h2:mt-4 prose-h2:font-sans
        prose-h3:text-lg prose-h3:font-normal prose-h3:mb-3 prose-h3:mt-3 prose-h3:font-sans
        prose-p:mt-0 prose-p:mb-2 prose-p:font-sans
        prose-ol:my-2 prose-ol:font-sans
        prose-ul:mt-0 prose-ul:mb-3 prose-ul:font-sans
        prose-li:m-0 prose-li:font-sans ${className}`}
    >
      <MarkdownPipeline content={content} />
    </div>
  );
});

/**
 * Streaming variant of MarkdownContent. The document is split into top-level
 * blocks; finished blocks parse and highlight once and are reused verbatim
 * across flushes, so only the growing tail block re-renders per throttle tick.
 * Rendered output matches MarkdownContent (same pipeline and components).
 */
export const StreamingMarkdownContent = memo(function StreamingMarkdownContent({
  content,
  className = '',
}: MarkdownContentProps) {
  const segments = useMemo(() => splitMarkdownBlocks(content), [content]);

  const tailIndex = segments.length - 1;
  return (
    <div
      className={`w-full overflow-x-hidden prose prose-sm text-start text-text-primary dark:prose-invert max-w-full word-break font-sans
        prose-pre:p-0 prose-pre:m-0 !p-0
        prose-code:break-all prose-code:whitespace-pre-wrap prose-code:font-mono
        prose-a:break-all prose-a:overflow-wrap-anywhere
        prose-table:table prose-table:w-full
        prose-blockquote:text-inherit
        prose-td:border prose-td:border-border-primary prose-td:p-2
        prose-th:border prose-th:border-border-primary prose-th:p-2
        prose-thead:bg-background-primary
        prose-h1:text-2xl prose-h1:font-normal prose-h1:mb-5 prose-h1:mt-0 prose-h1:font-sans
        prose-h2:text-xl prose-h2:font-normal prose-h2:mb-4 prose-h2:mt-4 prose-h2:font-sans
        prose-h3:text-lg prose-h3:font-normal prose-h3:mb-3 prose-h3:mt-3 prose-h3:font-sans
        prose-p:mt-0 prose-p:mb-2 prose-p:font-sans
        prose-ol:my-2 prose-ol:font-sans
        prose-ul:mt-0 prose-ul:mb-3 prose-ul:font-sans
        prose-li:m-0 prose-li:font-sans ${className}`}
    >
      {segments.map((segment, index) => (
        <MarkdownPipeline
          key={index === tailIndex ? 'md-tail' : `md-${index}:${segment}`}
          content={segment}
        />
      ))}
    </div>
  );
});

export default MarkdownContent;
