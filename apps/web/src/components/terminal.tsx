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
import { Spinner } from "@/components/ui/spinner";
import type { Run, StreamEvent } from "@/lib/types";

type Entry = { command: string; output: string };

/** Buttons say what happens; the command behind each one stays out of the way. */
const SUGGESTIONS = [
  { label: "compare", command: "run" },
  { label: "my results", command: "stats" },
  { label: "earlier test", command: "bench" },
  { label: "help", command: "help" },
];

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
  const [seconds, setSeconds] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const cursor = useRef(-1);

  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [entries, busy]);
  useEffect(() => () => abort.current?.abort(), []);
  // A visible clock, so a long answer does not look stuck.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [busy]);

  const print = (text: string) =>
    setEntries((all) => {
      const last = all.at(-1);
      if (!last) return all;
      return [
        ...all.slice(0, -1),
        { ...last, output: last.output ? `${last.output}\n${text}` : text },
      ];
    });

  async function run(raw: string, label?: string) {
    const line = raw.trim();
    if (!line || busy) return;
    setCommand("");
    cursor.current = -1;
    setHistory((h) => [...h.filter((x) => x !== line), line].slice(-100));
    if (line === "clear") return setEntries([]);
    setEntries((all) => [...all.slice(-19), { command: label ?? line, output: "" }]);
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
      print(abort.current.signal.aborted ? "stopped." : "the connection dropped. try again.");
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
      aria-label="chat"
      className="flex h-[70dvh] min-h-0 min-w-0 flex-col border-b border-border lg:h-auto lg:border-r lg:border-b-0"
    >
      <div
        ref={transcript}
        className="min-h-0 flex-1 overflow-auto px-4 py-4 text-xs sm:px-5"
        aria-live="polite"
      >
        {entries.length === 0 && (
          <div className="max-w-md leading-5">
            <p className="font-semibold">hi {username}, ask about the checkout problem.</p>
            <p className="mt-2 text-muted-foreground">
              promo codes started failing in a sample online store. the ai answers twice, the
              standard way and the optimized way, and you see which one was cheaper and faster. your
              results are private to you.
            </p>
          </div>
        )}
        <div className="space-y-5">
          {entries.map((e, i) => (
            <div key={i}>
              <p className="mb-1 leading-5 font-semibold normal-case">
                <span aria-hidden className="text-muted-foreground">
                  &gt;{" "}
                </span>
                {e.command}
              </p>
              <div className="normal-case">
                <CliAnsiOutput output={e.output} />
              </div>
            </div>
          ))}
          {busy && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3" /> working on it
              {seconds > 0 && (
                <span aria-hidden className="tabular-nums">
                  {seconds}s
                </span>
              )}
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
              key={s.command}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(s.command, s.label)}
            >
              {s.label}
            </Button>
          ))}
          {busy && (
            <Button type="button" variant="ghost" size="sm" onClick={() => abort.current?.abort()}>
              stop
            </Button>
          )}
        </div>
        <InputGroup className="h-9 border-border bg-transparent">
          <InputGroupAddon>
            <InputGroupText aria-hidden>&gt;</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            aria-label="your question"
            placeholder="why are promo codes failing?"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
            // 16px on touch screens, or iOS zooms the page when the field is focused.
            className="text-xs pointer-coarse:text-base"
          />
        </InputGroup>
      </form>
    </section>
  );
}
