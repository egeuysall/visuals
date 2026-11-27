import type { CSSProperties } from "react";

const SGR = /\x1b\[([\d;]*)m/g;
const OTHER = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// 30-37 map to ansi 0-7, 90-97 to 8-15; the theme variables live in globals.css.
const fg = (code: number) => `var(--terminal-ansi-${code >= 90 ? code - 90 + 8 : code - 30})`;

function parseLine(line: string) {
  const parts: Array<{ text: string; style: CSSProperties }> = [];
  let style: CSSProperties = {};
  let cursor = 0;
  let m: RegExpExecArray | null;
  SGR.lastIndex = 0;
  while ((m = SGR.exec(line))) {
    if (m.index > cursor) parts.push({ text: line.slice(cursor, m.index).replace(OTHER, ""), style });
    for (const raw of (m[1] || "0").split(";")) {
      const code = Number(raw || 0);
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, fontWeight: 600 };
      else if (code === 2) style = { ...style, opacity: 0.6 };
      else if (code === 22) style = { ...style, fontWeight: undefined, opacity: undefined };
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style = { ...style, color: fg(code) };
      else if (code === 39) style = { ...style, color: undefined };
    }
    cursor = SGR.lastIndex;
  }
  if (cursor < line.length) parts.push({ text: line.slice(cursor).replace(OTHER, ""), style });
  return parts;
}

// Block and box-drawing glyphs only join up when lines touch, so those lines get a tighter line height.
const BLOCKS = /[█▀▄▌▐▖▗▘▙▚▛▜▝▞▟]/;
const BOXES = /[│─┌┐└┘╭╮╰╯├┤┬┴┼]/;
const lineHeight = (plain: string) => (BLOCKS.test(plain) ? 1 : BOXES.test(plain) ? 1.12 : 1.3);

/** Renders SGR colors from the cli with the site's theme; everything else is plain text. */
export function CliAnsiOutput({ output }: { output: string }) {
  const lines = output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return (
    <pre className="font-mono text-xs break-words whitespace-pre-wrap">
      {lines.map((line, i) => (
        <span
          key={i}
          className="block"
          style={{ lineHeight: lineHeight(line.replace(SGR, "")), minHeight: "1.3em" }}
        >
          {parseLine(line).map((p, j) => (
            <span key={j} style={p.style}>
              {p.text}
            </span>
          ))}
        </span>
      ))}
    </pre>
  );
}
