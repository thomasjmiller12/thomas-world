import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// MarkdownBody — renders an agent-authored artifact body (the agents write in
// markdown) as a paper document, mapped onto the design tokens: Fredoka
// headings, Nunito Sans body, Silkscreen-adjacent mono for code, and the
// agent's hue for links/rules/blockquote accents. react-markdown emits no raw
// HTML by default, so visitor-facing bodies stay sanitized.

interface Props {
  body: string;
  // The owning agent's hue — accents (links, blockquote rule, hr) pick it up.
  color: string;
}

export function MarkdownBody({ body, color }: Props) {
  const blockGap = '0 0 14px';
  const components: Components = {
    h1: ({ children }) => (
      <h2 style={{ font: '700 21px var(--display)', color: 'var(--ink)', lineHeight: 1.25, margin: '22px 0 10px' }}>
        {children}
      </h2>
    ),
    h2: ({ children }) => (
      <h3 style={{ font: '700 18px var(--display)', color: 'var(--ink)', lineHeight: 1.3, margin: '20px 0 8px' }}>
        {children}
      </h3>
    ),
    h3: ({ children }) => (
      <h4 style={{ font: '700 15.5px var(--display)', color: 'var(--ink)', lineHeight: 1.35, margin: '18px 0 6px' }}>
        {children}
      </h4>
    ),
    h4: ({ children }) => (
      <h5
        style={{
          font: '700 11px var(--mono)',
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--ink-2)',
          margin: '16px 0 6px',
        }}
      >
        {children}
      </h5>
    ),
    p: ({ children }) => <p style={{ margin: blockGap }}>{children}</p>,
    ul: ({ children }) => <ul style={{ margin: blockGap, paddingLeft: 22, listStyle: 'disc' }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: blockGap, paddingLeft: 22, listStyle: 'decimal' }}>{children}</ol>,
    li: ({ children }) => <li style={{ margin: '0 0 5px' }}>{children}</li>,
    blockquote: ({ children }) => (
      <blockquote
        style={{
          margin: blockGap,
          padding: '4px 0 4px 14px',
          borderLeft: `3px solid ${color}`,
          color: 'var(--ink-2)',
          fontStyle: 'italic',
        }}
      >
        {children}
      </blockquote>
    ),
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color, fontWeight: 600, textDecorationColor: `${color}66` }}
      >
        {children}
      </a>
    ),
    code: ({ children, className }) =>
      // Block code arrives wrapped in <pre> (handled below); this styles both
      // the inline form and the inner element of fenced blocks.
      className ? (
        <code className={className} style={{ font: '400 12.5px ui-monospace, monospace' }}>
          {children}
        </code>
      ) : (
        <code
          style={{
            font: '400 12.5px ui-monospace, monospace',
            background: 'var(--paper-2)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            padding: '1px 5px',
          }}
        >
          {children}
        </code>
      ),
    pre: ({ children }) => (
      <pre
        style={{
          margin: blockGap,
          padding: '12px 14px',
          background: 'var(--paper-2)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          overflowX: 'auto',
          lineHeight: 1.55,
        }}
      >
        {children}
      </pre>
    ),
    hr: () => <div style={{ height: 3, width: 48, borderRadius: 999, background: `${color}55`, margin: '20px auto' }} />,
    table: ({ children }) => (
      <div style={{ overflowX: 'auto', margin: blockGap }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 13.5, minWidth: 320 }}>{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th
        style={{
          font: '700 10px var(--mono)',
          letterSpacing: '.05em',
          textTransform: 'uppercase',
          textAlign: 'left',
          color: 'var(--ink-2)',
          borderBottom: '2px solid var(--line-2)',
          padding: '6px 10px',
        }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td style={{ borderBottom: '1px solid var(--line)', padding: '6px 10px', verticalAlign: 'top' }}>{children}</td>
    ),
    img: ({ alt }) => (
      // Agents can't host images; render any stray image syntax as its alt
      // text rather than a broken-image glyph.
      <em style={{ color: 'var(--ink-3)' }}>{alt ? `[image: ${alt}]` : '[image]'}</em>
    ),
  };

  return (
    <div style={{ font: '400 15px var(--sans)', lineHeight: 1.7, color: 'var(--ink)', wordBreak: 'break-word' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
