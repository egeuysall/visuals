"use client";

import { useState } from "react";
import { Analytics } from "@/components/analytics/analytics";
import { Terminal } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/server/actions";
import type { Run } from "@/lib/types";

export function Workspace({ username, initialRuns }: { username: string; initialRuns: Run[] }) {
  const [runs, setRuns] = useState(initialRuns);
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4 sm:px-5">
        <span className="text-[15px] font-semibold">sdk</span>
        <form action={signOut} className="flex items-center gap-3">
          <span className="max-w-40 truncate text-xs text-muted-foreground">{username}</span>
          <Button type="submit" variant="ghost" size="sm">
            sign out
          </Button>
        </form>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(360px,5fr)_7fr]">
        <Terminal
          username={username}
          onRun={(run) => setRuns((all) => [...all, run].slice(-30))}
          onReset={() => setRuns([])}
        />
        <Analytics runs={runs} />
      </main>
    </div>
  );
}
