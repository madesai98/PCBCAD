import { Fragment, type ReactNode } from 'react';

/** Minimal, safe markdown renderer (no HTML passthrough): paragraphs, lists, code, bold/italic, links. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+\.)\s+/, ''));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(
        <L key={key++}>
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </L>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const H = (`h${h[1].length}` as 'h1' | 'h2' | 'h3');
      blocks.push(<H key={key++}>{inline(h[2])}</H>);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*([-*•]|\d+\.)\s+/.test(lines[i]) && !/^#{1,3}\s/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('*')) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (t.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(
        <a key={k++} href={mm[2]} target="_blank" rel="noreferrer">
          {mm[1]}
        </a>,
      );
    } else
      out.push(
        <a key={k++} href={t} target="_blank" rel="noreferrer">
          {t.length > 60 ? `${t.slice(0, 57)}…` : t}
        </a>,
      );
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
