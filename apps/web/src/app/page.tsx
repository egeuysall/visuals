import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { recentPairs, recentSummary } from "@/components/analytics/data";
import { EveryTest, Headline, OneQuestion } from "@/components/landing/charts";
import { SiteShell } from "@/components/site-shell";
import { buttonVariants } from "@/components/ui/button";
import recorded from "@/data/recorded-benchmark.json";
import { currentUser } from "@/lib/server/auth";
import { median, ratio } from "@/lib/stats";

const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

const WAYS = [
  [
    "looks things up all at once",
    "when the ai needs twelve things, it asks for them together instead of waiting for one before starting the next.",
  ],
  [
    "reads less",
    "long results are shortened before the ai sees them. the facts stay, the piles of repeated records go.",
  ],
  [
    "stops overthinking",
    "for this kind of question the long private reasoning is turned off. it is the biggest saving, and the one with a real cost.",
  ],
];

function Heading({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{children}</p>
    </div>
  );
}

export default async function Home() {
  if (await currentUser()) redirect("/app");
  const earlier = (k: "costUsd" | "latencyMs" | "toolDurationMs" | "inputTokens") =>
    `${ratio(median(recorded.control.map((r) => r[k])), median(recorded.treatment.map((r) => r[k])))!.toFixed(1)}x`;
  const rows = [
    ["cost", earlier("costUsd"), "cheaper"],
    ["text the ai has to read", earlier("inputTokens"), "less"],
    ["looking things up", earlier("toolDurationMs"), "faster"],
    ["total time", earlier("latencyMs"), "faster"],
  ];
  const actions = (
    <div className="flex flex-wrap gap-3">
      <Link href="/sign-up" className={buttonVariants({ size: "lg", className: "h-11 px-5" })}>
        try it yourself
      </Link>
      <Link
        href="/sign-in"
        className={buttonVariants({ size: "lg", variant: "outline", className: "h-11 px-5" })}
      >
        sign in
      </Link>
    </div>
  );

  return (
    <SiteShell wide>
      <section className="max-w-2xl">
        <h1
          className="animate-enter text-2xl leading-9 font-semibold tracking-tight text-balance sm:text-3xl sm:leading-10"
          style={delay(40)}
        >
          what if we build something that can make any ai model 5x cheaper and faster?
        </h1>
        <p
          className="animate-enter mt-4 text-sm leading-6 text-muted-foreground"
          style={delay(105)}
        >
          we built an sdk that changes how an ai works instead of which ai you use. ask it a
          question, watch it answer the standard way and the optimized way, and see the difference.
        </p>
        <div className="animate-enter mt-6" style={delay(170)}>
          {actions}
        </div>
      </section>

      <section className="animate-enter mt-14" style={delay(235)} aria-labelledby="so-far">
        <Heading id="so-far" title="how close we got">
          typical result from {recentPairs.length} test questions on one small ai model. cost passed
          5x. total time has not yet.
        </Heading>
        <Headline />
        <p className="mt-3 max-w-2xl text-xs leading-5">
          the catch: the optimized answer found every key fact in {recentSummary.optimizedFull} of{" "}
          {recentPairs.length} tries, and the standard answer in {recentSummary.standardFull}.{" "}
          <span className="text-muted-foreground">
            speed ranged from {recentSummary.slowest}x to {recentSummary.fastest}x. all questions
            are about one sample problem with made up data.
          </span>
        </p>
      </section>

      <section className="mt-14" aria-labelledby="how">
        <Heading id="how" title="three changes">
          the ai model stays the same.
        </Heading>
        <ol className="grid grid-cols-1 gap-px border border-border bg-border md:grid-cols-3">
          {WAYS.map(([title, body], i) => (
            <li key={title} className="bg-background p-5">
              <span className="text-xs text-vesper-orange tabular-nums">0{i + 1}</span>
              <h3 className="mt-2 text-xs font-semibold">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-14" aria-labelledby="one">
        <Heading id="one" title="watch one question">
          the staircase is the standard way waiting its turn.
        </Heading>
        <OneQuestion />
      </section>

      <section className="mt-14" aria-labelledby="all">
        <Heading id="all" title="all the tries">
          tap a measure to switch. hover a bar for the exact number.
        </Heading>
        <EveryTest />
      </section>

      <section className="mt-14" aria-labelledby="earlier">
        <Heading id="earlier" title="an earlier test on a bigger model">
          {recorded.control.length} tries each way on the same sample problem. cheaper held up,
          speed barely moved: a bigger model spends most of its time thinking and writing.
        </Heading>
        <dl className="max-w-xl border-t border-border text-xs">
          {rows.map(([label, value, word]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-4 border-b border-border py-3"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">
                <span className="text-sm font-semibold">{value}</span> {word}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-14 border-t border-border pt-10">
        <p className="mb-5 text-sm font-semibold">ask it something and check our numbers.</p>
        {actions}
      </section>
    </SiteShell>
  );
}
