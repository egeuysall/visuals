"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { CliAnsiOutput } from "@/components/cli-ansi-output";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import type { Run, StreamEvent } from "@/lib/types";

type Entry = { command: string; output: string };

const SUGGESTIONS = ["run", "run --thinking", "run --no-compact", "bench", "help"];

export function Terminal({
  username,
  onRun,
  onReset,
}: {
  username: string;
  onRun: (run: Run) => void;
  onReset: () => void;
}) {
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const cursor = useRef(-1);

  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [entries, busy]);
  useEffect(() => () => abort.current?.abort(), []);

  const print = (text: string) =>
    setEntries((all) => {
      const last = all.at(-1);
      if (!last) return all;
      return [
        ...all.slice(0, -1),
        { ...last, output: last.output ? `${last.output}\n${text}` : text },
      ];
    });

  async function run(raw: string) {
    const line = raw.trim();
    if (!line || busy) return;
    setCommand("");
    cursor.current = -1;
    setHistory((h) => [...h.filter((x) => x !== line), line].slice(-100));
    if (line === "clear") return setEntries([]);
    setEntries((all) => [...all.slice(-19), { command: line, output: "" }]);
    setBusy(true);
    abort.current = new AbortController();
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line }),
        signal: abort.current.signal,
      });
      if (res.status === 401) return window.location.assign("/sign-in");
      if (!res.ok || !res.body) return print(await res.text());
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const lines = (buffer + value).split("\n");
        buffer = lines.pop() ?? "";
        for (const l of lines) {
          const event = JSON.parse(l) as StreamEvent;
          if (event.type === "log") print(event.text);
          else if (event.type === "run") onRun(event.run);
          else onReset();
        }
      }
    } catch {
      print(abort.current.signal.aborted ? "cancelled." : "the connection dropped. try again.");
    } finally {
      setBusy(false);
      input.current?.focus({ preventScroll: true });
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.ctrlKey && e.key.toLowerCase() === "c" && busy) return abort.current?.abort();
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      return setEntries([]);
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    cursor.current = Math.max(
      -1,
      Math.min(history.length - 1, cursor.current + (e.key === "ArrowUp" ? 1 : -1)),
    );
    setCommand(cursor.current < 0 ? "" : (history[history.length - 1 - cursor.current] ?? ""));
  }

  return (
    <section
      aria-label="terminal"
      className="flex h-[70dvh] min-h-0 min-w-0 flex-col border-b border-border lg:h-auto lg:border-r lg:border-b-0"
    >
      <div
        ref={transcript}
        className="min-h-0 flex-1 overflow-auto px-4 py-4 text-xs sm:px-5"
        aria-live="polite"
      >
        <p className="leading-5 text-muted-foreground">
          visuals · signed in as {username} · your runs and memory are private to you
        </p>
        {entries.length === 0 && (
          <p className="mt-4 leading-5 text-muted-foreground">
            type <code>run</code> to compare the baseline agent with the optimized runtime.
          </p>
        )}
        <div className="mt-4 space-y-4">
          {entries.map((e, i) => (
            <div key={i}>
              <p className="leading-5 font-semibold normal-case">$ {e.command}</p>
              <div className="normal-case">
                <CliAnsiOutput output={e.output} />
              </div>
            </div>
          ))}
          {busy && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3" /> running
            </p>
          )}
        </div>
      </div>
      <form
        className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(command);
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        <InputGroup className="h-11 border-border bg-transparent lg:h-9">
          <InputGroupAddon>
            <InputGroupText>$</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            aria-label="command"
            placeholder='run "why are promo codes failing?"'
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
            className="text-base sm:text-[13px]"
          />
        </InputGroup>
        <p className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <Kbd>enter</Kbd> run <Kbd>↑</Kbd> history <Kbd>ctrl c</Kbd> cancel <Kbd>ctrl l</Kbd> clear
        </p>
      </form>
    </section>
  );
}
