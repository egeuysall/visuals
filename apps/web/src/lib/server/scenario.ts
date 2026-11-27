// The incident-investigation fixture from examples/benchmark in the imported SDK: twelve
// independent read-only sources. The data is made up; the tool calls and timing are real.
interface IncidentSource {
  id: string;
  name: string;
  description: string;
  result: Record<string, unknown>;
}

export const incidentSources: IncidentSource[] = [
  {
    id: "tracker/get-issue",
    name: "get_issue",
    description: "Read the issue title, symptoms, status, and first-seen timestamp.",
    result: {
      title: "Checkout intermittently rejects valid promo codes",
      status: "open",
      firstSeen: "2026-08-04T14:02:00Z",
      symptoms: ["promo validation returns 500", "error rate spikes after deploy"],
    },
  },
  {
    id: "tracker/get-comments",
    name: "get_comments",
    description: "Read customer and support comments attached to the issue.",
    result: {
      comments: [
        "Several customers report the failure only on carts with regional tax enabled.",
        "Support reproduced it after the afternoon checkout deployment.",
      ],
    },
  },
  {
    id: "git/list-related-commits",
    name: "list_related_commits",
    description: "Read commits and pull requests linked to the issue.",
    result: {
      changes: [
        { sha: "8f4c2a1", title: "Use normalized region in promo validation", mergedAt: "13:48Z" },
        { sha: "2bc91de", title: "Refactor tax and discount pipeline", mergedAt: "12:57Z" },
      ],
    },
  },
  {
    id: "git/get-code-ownership",
    name: "get_code_ownership",
    description: "Read the owning team and reviewers for checkout promotion code.",
    result: {
      team: "Checkout Platform",
      owner: "checkout-platform",
      reviewers: ["payments-oncall"],
    },
  },
  {
    id: "observability/search-logs",
    name: "search_logs",
    description: "Read production logs for the issue identifier and checkout error signature.",
    result: {
      error: "TypeError: cannot read properties of undefined (reading 'countryCode')",
      occurrences: 1842,
      window: "14:00-14:20Z",
      sampleService: "checkout-api",
    },
  },
  {
    id: "observability/get-deployment",
    name: "get_deployment",
    description: "Read the production deployment, release version, and rollout status.",
    result: {
      release: "checkout-api@2026.08.04.3",
      deployedAt: "2026-08-04T13:52:00Z",
      rollout: "100%",
      changedFiles: ["src/promo/normalize-region.ts", "src/tax/discount-context.ts"],
    },
  },
  {
    id: "observability/get-metrics",
    name: "get_metrics",
    description:
      "Read checkout error rate, latency, and regional breakdown for the incident window.",
    result: {
      baselineErrorRate: "0.18%",
      incidentErrorRate: "8.7%",
      p95LatencyMs: 1280,
      affectedRegions: ["EU", "UK"],
    },
  },
  {
    id: "config/get-feature-flags",
    name: "get_feature_flags",
    description: "Read feature flags affecting promo and tax normalization in production.",
    result: {
      flags: [
        { key: "promo-region-normalization", enabled: true, rollout: "100%" },
        { key: "regional-tax-v2", enabled: true, rollout: "100%" },
      ],
    },
  },
  {
    id: "docs/search-runbook",
    name: "search_runbook",
    description: "Read the incident runbook and approved mitigation for checkout failures.",
    result: {
      mitigation: "Disable promo-region-normalization or roll back checkout-api@2026.08.04.3.",
      verification: "Confirm promo validation 5xx rate returns below 0.5% for 10 minutes.",
    },
  },
  {
    id: "docs/search-design",
    name: "search_design_docs",
    description: "Read design documentation for the tax and promotion normalization contract.",
    result: {
      contract:
        "Tax context may omit countryCode for legacy carts; promo validation must preserve that case.",
      migrationNote:
        "The new normalizer assumes a region object exists when regional-tax-v2 is enabled.",
    },
  },
  {
    id: "git/list-recent-changes",
    name: "list_recent_changes",
    description: "Read recent production changes touching checkout, tax, and promotion code.",
    result: {
      changes: [
        "Promo normalization moved ahead of legacy-cart compatibility handling.",
        "Regional tax rollout changed from 10% canary to 100% immediately before the incident.",
      ],
    },
  },
  {
    id: "incidents/get-history",
    name: "get_incident_history",
    description: "Read prior incidents with similar checkout or regional-tax symptoms.",
    result: {
      incidents: [
        {
          id: "INC-77",
          lesson: "Legacy carts can omit region metadata; guard before normalization.",
        },
        {
          id: "INC-51",
          lesson: "Rollout flags should remain canary until regional metrics stabilize.",
        },
      ],
    },
  },
];

export const TOOL_DELAY_MS = 120;

const KEY_FACTS = [
  /countrycode/i,
  /promo-region-normalization|regional-tax-v2/i,
  /legacy/i,
  /roll(ed|ing)?[\s-]?back|disabl/i,
];

/** How many of the incident's key facts an answer mentions. Keywords only, so read the answer too. */
export const factCheck = (answer: string) => ({
  found: KEY_FACTS.filter((fact) => fact.test(answer)).length,
  total: KEY_FACTS.length,
});

export const DEFAULT_TASK = "Investigate production issue ENG-142 and report the root cause.";

export const SYSTEM_PROMPT = `You are the incident commander for production issue ENG-142.
Before answering, request every read-only source, all together in the same turn.
Call each with {"issueId":"ENG-142"}. The reads are independent.
Answer the request concisely, using only facts the sources returned. Never invent a fact or a number.
If the sources do not answer the request, say so.
Write plain text in short paragraphs, with no markdown.`;
