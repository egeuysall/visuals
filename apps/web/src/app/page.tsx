import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { SiteShell } from "@/components/site-shell";
import { buttonVariants } from "@/components/ui/button";
import recorded from "@/data/recorded-benchmark.json";
import { currentUser } from "@/lib/server/auth";
import { median, ratio } from "@/lib/stats";

const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

export default async function Home() {
  if (await currentUser()) redirect("/app");
  const gain = (k: "costUsd" | "latencyMs" | "toolDurationMs" | "inputTokens") =>
    `${ratio(median(recorded.control.map((r) => r[k])), median(recorded.treatment.map((r) => r[k])))!.toFixed(1)}x`;
  const rows = [
    ["estimated cost per task", gain("costUsd"), "cheaper"],
    ["input tokens", gain("inputTokens"), "fewer"],
    ["tool phase", gain("toolDurationMs"), "faster"],
    ["end to end", gain("latencyMs"), "faster"],
  ];
  return (
    <SiteShell>
      <h1 className="animate-enter text-sm leading-6 font-semibold" style={delay(40)}>
        what if we build something that can make any ai model 5x cheaper and faster?
      </h1>
      <p className="animate-enter mt-2 text-xs leading-5 text-muted-foreground" style={delay(105)}>
        by optimizing tool calling, tool results and reasoning. run the same task with and without
        the runtime from a terminal, and see where the time and money go.
      </p>

      <section className="animate-enter mt-8" style={delay(170)} aria-labelledby="measured">
        <h2 id="measured" className="text-xs font-semibold">
          where it stands
        </h2>
        <dl className="mt-2 border-t border-border text-xs">
          {rows.map(([label, value, word]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-4 border-b border-border py-2.5"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">
                <span className="text-sm font-semibold">{value}</span> {word}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          medians of {recorded.control.length} runs per arm, {recorded.model}, recorded{" "}
          {recorded.generatedAt.slice(0, 10)} on one incident investigation task with twelve
          read-only tools. one workload, not a general guarantee.
        </p>
      </section>

      <div className="animate-enter mt-8 flex gap-3" style={delay(235)}>
        <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
          create account
        </Link>
        <Link href="/sign-in" className={buttonVariants({ size: "lg", variant: "outline" })}>
          sign in
        </Link>
      </div>
    </SiteShell>
  );
}
