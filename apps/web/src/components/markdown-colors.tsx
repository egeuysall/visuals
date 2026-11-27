import type { ReactNode } from "react";

// Markdown shown as written, only colored, in the Vesper palette (see globals.css).
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;

const paint = (color: string, text: string, key: number | string) => (
  <span key={key} className={color}>
    {text}
  </span>
);

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [found, code, bold] = match;
    out.push(text.slice(last, match.index));
    if (code) out.push(paint("text-vesper-mint", found, match.index));
    else if (bold) out.push(paint("text-vesper-orange", found, match.index));
    else {
      const split = found.indexOf("](") + 1;
      out.push(paint("text-vesper-orange", found.slice(0, split), match.index));
      out.push(paint("text-muted-foreground underline", found.slice(split), `${match.index}-url`));
    }
    last = match.index + found.length;
  }
  out.push(text.slice(last));
  return out;
}

function colorLine(line: string, fenced: boolean): ReactNode {
  if (line.trimStart().startsWith("```")) return paint("text-muted-foreground", line, 0);
  if (fenced) return paint("text-vesper-mint", line, 0);
  if (/^#{1,6}\s/.test(line)) return paint("text-vesper-orange", line, 0);
  if (line.startsWith(">")) return paint("text-muted-foreground", line, 0);
  const item = /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/.exec(line);
  if (!item) return inline(line);
  return [paint("text-vesper-mint", item[1]!, "marker"), ...inline(item[2]!)];
}

export function MarkdownColors({ text }: { text: string }) {
  let fenced = false;
  return (
    <pre className="font-mono text-xs leading-5 break-words whitespace-pre-wrap">
      {text.split("\n").map((line, i) => {
        const inside = fenced;
        if (line.trimStart().startsWith("```")) fenced = !fenced;
        return (
          <span key={i} className="block min-h-5">
            {colorLine(line, inside)}
          </span>
        );
      })}
    </pre>
  );
}
