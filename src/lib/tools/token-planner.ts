/**
 * Token & Cost Planner. Pure calculation module.
 *
 * tools-nixfred-prds/tools/02-TOKEN-PLANNER.md: estimate context usage,
 * request cost, monthly cost, and headroom using editable assumptions.
 *
 * This file holds no DOM references and no browser globals. It is safe
 * to import from a server render, a client script, or a test runner.
 * The page (src/pages/tools/token-planner.astro) owns all rendering
 * and event wiring; this file owns the arithmetic, the state shape,
 * and the ToolModule contract from src/data/types.ts.
 *
 * ROUNDING RULE, load bearing for acceptance criterion 3: every
 * function in this file that returns a number returns full floating
 * point precision. Nothing here calls toFixed, Math.round, or any
 * other rounding operation on a cost or token figure. Rounding for
 * display happens only in formatCurrency and formatTokens below, and
 * those are called only at render time, never fed back into a further
 * calculation. tests/tool-token-planner.mjs proves a long chain of
 * additions and multiplications does not drift when rounding is
 * deferred this way.
 */

import type { ExportAdapter, ValidationIssue } from '../../data/types';

/* ====================================================================
   1. PRICING PROFILES

   A small built in table of published list prices, per million tokens,
   as a starting point. Every profile is editable in the page: picking
   a profile pre-fills the three price fields for a scenario, and the
   visitor can then change any of them without restriction. Custom
   pricing (acceptance criterion 1) is therefore not a separate mode,
   it is just editing the numbers.
   ==================================================================== */

export interface PricingProfile {
  /** Stable key. Selected by a Field of type select. */
  id: string;
  /** Display label shown in the select and in assumption sources. */
  label: string;
  /** USD per 1,000,000 uncached input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
  /** USD per 1,000,000 cached (already primed) input tokens. */
  cachedInputPerMillion: number;
  /** Where the number came from, and how sure this build is of it. */
  source: string;
}

/**
 * The date this table was last checked against a published price
 * list. Rendered on screen per the PRD boundary: pricing data must
 * show its effective date and remain editable.
 */
export const PRICING_EFFECTIVE_DATE = '2026-07-26';

/**
 * Anthropic rows are first party list prices. The cached input rate
 * for every Anthropic model is ten percent of the input rate, which
 * is the published discount for a prompt cache read.
 *
 * OpenAI rows track the flagship, mini, and nano tiers at the price
 * points this build could confirm from two independent published
 * sources. The exact current model name moves faster than this table
 * can be verified against a live source, so the label says "class"
 * rather than naming one version number, and the source note says so
 * plainly rather than inventing a precision this build does not have.
 */
export const PRICING_PROFILES: PricingProfile[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cachedInputPerMillion: 0.5,
    source: 'Anthropic published list price',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cachedInputPerMillion: 0.3,
    source: 'Anthropic published list price',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cachedInputPerMillion: 0.1,
    source: 'Anthropic published list price',
  },
  {
    id: 'openai-flagship',
    label: 'OpenAI flagship class (GPT 5 series)',
    inputPerMillion: 5.0,
    outputPerMillion: 30.0,
    cachedInputPerMillion: 0.5,
    source: 'Published OpenAI list price, confirm current model id before billing decisions',
  },
  {
    id: 'openai-mini',
    label: 'OpenAI mini class (GPT 5 series)',
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    cachedInputPerMillion: 0.075,
    source: 'Published OpenAI list price, confirm current model id before billing decisions',
  },
  {
    id: 'openai-nano',
    label: 'OpenAI nano class (GPT 5 series)',
    inputPerMillion: 0.2,
    outputPerMillion: 1.25,
    cachedInputPerMillion: 0.02,
    source: 'Published OpenAI list price, confirm current model id before billing decisions',
  },
  {
    id: 'custom',
    label: 'Custom pricing',
    inputPerMillion: 0,
    outputPerMillion: 0,
    cachedInputPerMillion: 0,
    source: 'Entered by hand',
  },
];

export function getPricingProfile(id: string): PricingProfile {
  return PRICING_PROFILES.find((p) => p.id === id) ?? PRICING_PROFILES[0];
}

/* ====================================================================
   2. STATE SHAPE
   ==================================================================== */

export const TIME_PERIODS = ['day', 'week', 'month', 'year'] as const;
export type TimePeriod = (typeof TIME_PERIODS)[number];

/** Days used to normalize a period to a daily rate, and back out to a
 * displayed monthly or annual figure. Thirty and three hundred sixty
 * five are stated assumptions, not hidden constants, and are shown on
 * screen wherever they are used. */
export const DAYS_PER_PERIOD: Record<TimePeriod, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

export const DAYS_PER_MONTH = 30;
export const DAYS_PER_YEAR = 365;

export interface ScenarioInputs {
  /** Visible name for this scenario, shown in headings and exports. */
  name: string;
  /** Selected pricing profile id. Only affects pre fill; the three
   * price fields below are the values actually used. */
  profileId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  /** Tokens spent on the system prompt for every model call. */
  systemPromptTokens: number;
  /** Average visitor facing input tokens per request, excluding the
   * system prompt. */
  avgInputTokens: number;
  /** Average output tokens per request. */
  avgOutputTokens: number;
  /** How many requests this scenario handles per the shared period. */
  requestsPerPeriod: number;
  /** Percent, 0 to 100 and up, of requests that need one extra retry
   * (a full repeat model call) before they succeed. */
  retryRatePercent: number;
  /** Percent, 0 to 100, of the system prompt plus input tokens that
   * are served from a prompt cache rather than billed at the full
   * input rate. */
  cacheHitRatePercent: number;
}

export interface TokenPlannerState {
  /** Period the two requestsPerPeriod figures are expressed in.
   * Shared across both scenarios so a comparison is apples to apples. */
  period: TimePeriod;
  /** Whether scenario B is shown alongside scenario A. */
  compareEnabled: boolean;
  scenarioA: ScenarioInputs;
  scenarioB: ScenarioInputs;
}

/* ====================================================================
   3. CALCULATION

   Every number below is derived by one visible formula. The formula
   strings are built alongside the numbers so the page can print the
   actual arithmetic, not just the answer, per acceptance criterion 2.
   ==================================================================== */

export interface ScenarioResult {
  /** system prompt tokens plus average input tokens, per model call. */
  rawInputTokensPerExecution: number;
  cachedInputTokensPerExecution: number;
  uncachedInputTokensPerExecution: number;
  outputTokensPerExecution: number;
  totalTokensPerExecution: number;

  uncachedInputCostPerExecution: number;
  cachedInputCostPerExecution: number;
  outputCostPerExecution: number;
  costPerExecution: number;

  /** 1 plus the retry rate as a fraction. Average model calls needed
   * to satisfy one visitor facing request. */
  executionsPerRequest: number;
  costPerRequest: number;
  tokensPerRequest: number;

  requestsPerDay: number;
  executionsPerDay: number;
  dailyCost: number;
  monthlyCost: number;
  annualCost: number;
  dailyTokens: number;
  monthlyTokens: number;
  annualTokens: number;

  majorDriver: 'uncached input' | 'cached input' | 'output';
  majorDriverShare: number;

  formulas: {
    rawInput: string;
    cacheSplit: string;
    uncachedCost: string;
    cachedCost: string;
    outputCost: string;
    costPerExecution: string;
    executionsPerRequest: string;
    costPerRequest: string;
    requestsPerDay: string;
    monthlyCost: string;
    annualCost: string;
  };
}

export function calculateScenario(inputs: ScenarioInputs, period: TimePeriod): ScenarioResult {
  const rawInputTokensPerExecution = inputs.systemPromptTokens + inputs.avgInputTokens;
  const cacheFraction = clampFraction(inputs.cacheHitRatePercent / 100);
  const cachedInputTokensPerExecution = rawInputTokensPerExecution * cacheFraction;
  const uncachedInputTokensPerExecution = rawInputTokensPerExecution * (1 - cacheFraction);
  const outputTokensPerExecution = inputs.avgOutputTokens;
  const totalTokensPerExecution = rawInputTokensPerExecution + outputTokensPerExecution;

  const uncachedInputCostPerExecution =
    (uncachedInputTokensPerExecution / 1_000_000) * inputs.inputPerMillion;
  const cachedInputCostPerExecution =
    (cachedInputTokensPerExecution / 1_000_000) * inputs.cachedInputPerMillion;
  const outputCostPerExecution = (outputTokensPerExecution / 1_000_000) * inputs.outputPerMillion;
  const costPerExecution =
    uncachedInputCostPerExecution + cachedInputCostPerExecution + outputCostPerExecution;

  const retryFraction = Math.max(0, inputs.retryRatePercent / 100);
  const executionsPerRequest = 1 + retryFraction;
  const costPerRequest = costPerExecution * executionsPerRequest;
  const tokensPerRequest = totalTokensPerExecution * executionsPerRequest;

  const daysInPeriod = DAYS_PER_PERIOD[period];
  const requestsPerDay = daysInPeriod > 0 ? inputs.requestsPerPeriod / daysInPeriod : 0;
  const executionsPerDay = requestsPerDay * executionsPerRequest;
  const dailyCost = costPerExecution * executionsPerDay;
  const monthlyCost = dailyCost * DAYS_PER_MONTH;
  const annualCost = dailyCost * DAYS_PER_YEAR;
  const dailyTokens = totalTokensPerExecution * executionsPerDay;
  const monthlyTokens = dailyTokens * DAYS_PER_MONTH;
  const annualTokens = dailyTokens * DAYS_PER_YEAR;

  const driverEntries: Array<['uncached input' | 'cached input' | 'output', number]> = [
    ['uncached input', uncachedInputCostPerExecution],
    ['cached input', cachedInputCostPerExecution],
    ['output', outputCostPerExecution],
  ];
  driverEntries.sort((a, b) => b[1] - a[1]);
  const [majorDriver, majorDriverValue] = driverEntries[0];
  const majorDriverShare = costPerExecution > 0 ? majorDriverValue / costPerExecution : 0;

  const periodWord = period === 'day' ? 'per day already' : `per ${period}`;

  return {
    rawInputTokensPerExecution,
    cachedInputTokensPerExecution,
    uncachedInputTokensPerExecution,
    outputTokensPerExecution,
    totalTokensPerExecution,
    uncachedInputCostPerExecution,
    cachedInputCostPerExecution,
    outputCostPerExecution,
    costPerExecution,
    executionsPerRequest,
    costPerRequest,
    tokensPerRequest,
    requestsPerDay,
    executionsPerDay,
    dailyCost,
    monthlyCost,
    annualCost,
    dailyTokens,
    monthlyTokens,
    annualTokens,
    majorDriver,
    majorDriverShare,
    formulas: {
      rawInput: `${formatTokens(inputs.systemPromptTokens)} system prompt tokens plus ${formatTokens(inputs.avgInputTokens)} input tokens equals ${formatTokens(rawInputTokensPerExecution)} tokens per model call.`,
      cacheSplit: `${formatTokens(rawInputTokensPerExecution)} tokens times a ${formatPercent(inputs.cacheHitRatePercent)} cache hit rate equals ${formatTokens(cachedInputTokensPerExecution)} cached tokens and ${formatTokens(uncachedInputTokensPerExecution)} uncached tokens.`,
      uncachedCost: `${formatTokens(uncachedInputTokensPerExecution)} uncached tokens divided by 1,000,000 times $${inputs.inputPerMillion} equals ${formatCurrency(uncachedInputCostPerExecution, 6)}.`,
      cachedCost: `${formatTokens(cachedInputTokensPerExecution)} cached tokens divided by 1,000,000 times $${inputs.cachedInputPerMillion} equals ${formatCurrency(cachedInputCostPerExecution, 6)}.`,
      outputCost: `${formatTokens(outputTokensPerExecution)} output tokens divided by 1,000,000 times $${inputs.outputPerMillion} equals ${formatCurrency(outputCostPerExecution, 6)}.`,
      costPerExecution: `${formatCurrency(uncachedInputCostPerExecution, 6)} plus ${formatCurrency(cachedInputCostPerExecution, 6)} plus ${formatCurrency(outputCostPerExecution, 6)} equals ${formatCurrency(costPerExecution, 6)} per model call.`,
      executionsPerRequest: `1 base call plus a ${formatPercent(inputs.retryRatePercent)} average retry rate equals ${executionsPerRequest.toFixed(3)} model calls per request.`,
      costPerRequest: `${formatCurrency(costPerExecution, 6)} times ${executionsPerRequest.toFixed(3)} calls equals ${formatCurrency(costPerRequest, 6)} per request.`,
      requestsPerDay: `${formatTokens(inputs.requestsPerPeriod)} requests ${periodWord}${period === 'day' ? '' : ` divided by ${daysInPeriod} days`} equals ${formatTokens(requestsPerDay)} requests per day.`,
      monthlyCost: `${formatCurrency(costPerRequest, 6)} per request times ${formatTokens(requestsPerDay)} requests per day times ${DAYS_PER_MONTH} days equals ${formatCurrency(monthlyCost)} per month.`,
      annualCost: `${formatCurrency(costPerRequest, 6)} per request times ${formatTokens(requestsPerDay)} requests per day times ${DAYS_PER_YEAR} days equals ${formatCurrency(annualCost)} per year.`,
    },
  };
}

function clampFraction(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ====================================================================
   4. THRESHOLD WARNINGS
   ==================================================================== */

export interface ThresholdWarning {
  key: string;
  severity: 'info' | 'warning' | 'alert';
  title: string;
  body: string;
}

/**
 * Computes the warnings that apply right now. Returns [] when nothing
 * is worth flagging beyond the standing estimate disclaimer, which the
 * page renders on its own, unconditionally.
 */
export function getThresholdWarnings(
  state: TokenPlannerState,
  resultA: ScenarioResult,
  resultB: ScenarioResult | null,
): ThresholdWarning[] {
  const warnings: ThresholdWarning[] = [];

  if (state.scenarioA.requestsPerPeriod <= 0 && (!resultB || state.scenarioB.requestsPerPeriod <= 0)) {
    warnings.push({
      key: 'zero-requests',
      severity: 'info',
      title: 'No request volume entered',
      body: 'Per request cost below is still calculated, but every period total is zero until a request volume is entered.',
    });
  }

  for (const [label, inputs, result] of [
    ['Scenario A', state.scenarioA, resultA],
    ...(resultB ? [['Scenario B', state.scenarioB, resultB] as const] : []),
  ] as Array<[string, ScenarioInputs, ScenarioResult]>) {
    if (inputs.cacheHitRatePercent === 0 && inputs.systemPromptTokens > 500) {
      const withCache = calculateScenario({ ...inputs, cacheHitRatePercent: 90 }, state.period);
      const savingsPerMonth = result.monthlyCost - withCache.monthlyCost;
      if (savingsPerMonth > 0) {
        warnings.push({
          key: `cache-opportunity-${label}`,
          severity: 'warning',
          title: `${label} has no prompt caching`,
          body: `A ${formatTokens(inputs.systemPromptTokens)} token system prompt with a 90 percent cache hit rate would save about ${formatCurrency(savingsPerMonth)} a month on this scenario, before any change in output.`,
        });
      }
    }

    if (inputs.retryRatePercent > 20) {
      const retryShare = result.executionsPerRequest > 0 ? 1 - 1 / result.executionsPerRequest : 0;
      warnings.push({
        key: `retry-overhead-${label}`,
        severity: 'warning',
        title: `${label} has a high retry rate`,
        body: `At a ${formatPercent(inputs.retryRatePercent)} retry rate, about ${formatPercent(retryShare * 100)} of this scenario's cost is retry overhead rather than the first attempt.`,
      });
    }

    if (result.monthlyCost > 5000) {
      warnings.push({
        key: `high-spend-${label}`,
        severity: 'alert',
        title: `${label} projects a large monthly spend`,
        body: `${label} projects to about ${formatCurrency(result.monthlyCost)} a month at these volumes. Confirm the request volume and token sizes before treating this as a budget figure.`,
      });
    }
  }

  return warnings;
}

export interface ScenarioComparison {
  cheaper: 'A' | 'B' | 'equal';
  monthlyCostDelta: number;
  monthlyCostPercentDelta: number;
  formula: string;
}

/**
 * Compares two already computed scenarios on monthly cost. Kept
 * separate from calculateScenario so a single scenario view never
 * pays for a comparison it did not ask for.
 */
export function compareScenarios(resultA: ScenarioResult, resultB: ScenarioResult): ScenarioComparison {
  const monthlyCostDelta = resultB.monthlyCost - resultA.monthlyCost;
  const monthlyCostPercentDelta =
    resultA.monthlyCost > 0 ? (monthlyCostDelta / resultA.monthlyCost) * 100 : 0;

  let cheaper: 'A' | 'B' | 'equal' = 'equal';
  if (monthlyCostDelta < 0) cheaper = 'B';
  else if (monthlyCostDelta > 0) cheaper = 'A';

  const direction = monthlyCostDelta <= 0 ? 'less' : 'more';
  const formula = `${formatCurrency(resultB.monthlyCost)} minus ${formatCurrency(resultA.monthlyCost)} equals ${formatCurrency(Math.abs(monthlyCostDelta))} ${direction} per month for scenario B, a ${formatPercent(Math.abs(monthlyCostPercentDelta))} difference.`;

  return { cheaper, monthlyCostDelta, monthlyCostPercentDelta, formula };
}

/* ====================================================================
   5. FORMATTING, render time only

   Nothing above this line ever calls these. That separation is what
   acceptance criterion 3 is checking: rounding is a presentation
   concern, never an input to another calculation.
   ==================================================================== */

export function formatCurrency(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '$0.00';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

/* ====================================================================
   6. TOOL MODULE CONTRACT
   ==================================================================== */

function defaultScenario(name: string, profileId: string): ScenarioInputs {
  const profile = getPricingProfile(profileId);
  return {
    name,
    profileId,
    inputPerMillion: profile.inputPerMillion,
    outputPerMillion: profile.outputPerMillion,
    cachedInputPerMillion: profile.cachedInputPerMillion,
    systemPromptTokens: 0,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    requestsPerPeriod: 0,
    retryRatePercent: 0,
    cacheHitRatePercent: 0,
  };
}

export function emptyState(): TokenPlannerState {
  return {
    period: 'day',
    compareEnabled: false,
    scenarioA: defaultScenario('Scenario A', 'claude-opus-5'),
    scenarioB: defaultScenario('Scenario B', 'claude-haiku-4-5'),
  };
}

export function sampleState(): TokenPlannerState {
  return {
    period: 'day',
    compareEnabled: true,
    scenarioA: {
      name: 'Claude Opus 5 today',
      profileId: 'claude-opus-5',
      inputPerMillion: 5.0,
      outputPerMillion: 25.0,
      cachedInputPerMillion: 0.5,
      systemPromptTokens: 1200,
      avgInputTokens: 400,
      avgOutputTokens: 600,
      requestsPerPeriod: 5000,
      retryRatePercent: 3,
      cacheHitRatePercent: 0,
    },
    scenarioB: {
      name: 'Claude Haiku 4.5 with caching',
      profileId: 'claude-haiku-4-5',
      inputPerMillion: 1.0,
      outputPerMillion: 5.0,
      cachedInputPerMillion: 0.1,
      systemPromptTokens: 1200,
      avgInputTokens: 400,
      avgOutputTokens: 600,
      requestsPerPeriod: 5000,
      retryRatePercent: 3,
      cacheHitRatePercent: 80,
    },
  };
}

export function reset(): TokenPlannerState {
  return emptyState();
}

/**
 * field on the returned issue is "scenarioKey.propertyName", matching
 * the ScenarioInputs keys exactly, so a caller (the page's client
 * script) can locate the offending control without parsing a human
 * readable label back apart.
 */
function validateScenario(
  scenarioKey: 'scenarioA' | 'scenarioB',
  label: string,
  inputs: ScenarioInputs,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nonNegative: Array<[keyof ScenarioInputs, string]> = [
    ['inputPerMillion', 'input price'],
    ['outputPerMillion', 'output price'],
    ['cachedInputPerMillion', 'cached input price'],
    ['systemPromptTokens', 'system prompt tokens'],
    ['avgInputTokens', 'average input tokens'],
    ['avgOutputTokens', 'average output tokens'],
    ['requestsPerPeriod', 'requests'],
  ];

  for (const [prop, message] of nonNegative) {
    const value = inputs[prop];
    if (typeof value === 'number' && (Number.isNaN(value) || value < 0)) {
      issues.push({
        field: `${scenarioKey}.${prop}`,
        message: `${label}: ${message} must be zero or a positive number.`,
        severity: 'error',
      });
    }
  }

  if (Number.isNaN(inputs.cacheHitRatePercent) || inputs.cacheHitRatePercent < 0 || inputs.cacheHitRatePercent > 100) {
    issues.push({
      field: `${scenarioKey}.cacheHitRatePercent`,
      message: `${label}: cache hit rate is a percent of tokens, so it must be between 0 and 100.`,
      severity: 'error',
    });
  }

  if (Number.isNaN(inputs.retryRatePercent) || inputs.retryRatePercent < 0) {
    issues.push({
      field: `${scenarioKey}.retryRatePercent`,
      message: `${label}: retry rate must be zero or a positive percent.`,
      severity: 'error',
    });
  } else if (inputs.retryRatePercent > 100) {
    issues.push({
      field: `${scenarioKey}.retryRatePercent`,
      message: `${label}: a retry rate above 100 percent means most requests retry more than once. Confirm that is intended.`,
      severity: 'warning',
    });
  }

  return issues;
}

export function validate(state: TokenPlannerState): ValidationIssue[] {
  const issues = [...validateScenario('scenarioA', 'Scenario A', state.scenarioA)];
  if (state.compareEnabled) {
    issues.push(...validateScenario('scenarioB', 'Scenario B', state.scenarioB));
  }
  return issues;
}

/* ====================================================================
   7. EXPORT ADAPTER
   ==================================================================== */

interface ExportRow {
  label: string;
  scenarioA: string;
  scenarioB: string | null;
}

function buildExportRows(state: TokenPlannerState, resultA: ScenarioResult, resultB: ScenarioResult | null): ExportRow[] {
  const b = (fn: (r: ScenarioResult) => string): string | null => (resultB ? fn(resultB) : null);
  return [
    { label: 'Scenario name', scenarioA: state.scenarioA.name, scenarioB: state.compareEnabled ? state.scenarioB.name : null },
    { label: 'Cost per request', scenarioA: formatCurrency(resultA.costPerRequest, 6), scenarioB: b((r) => formatCurrency(r.costPerRequest, 6)) },
    { label: 'Daily cost', scenarioA: formatCurrency(resultA.dailyCost), scenarioB: b((r) => formatCurrency(r.dailyCost)) },
    { label: 'Monthly cost', scenarioA: formatCurrency(resultA.monthlyCost), scenarioB: b((r) => formatCurrency(r.monthlyCost)) },
    { label: 'Annual cost', scenarioA: formatCurrency(resultA.annualCost), scenarioB: b((r) => formatCurrency(r.annualCost)) },
    { label: 'Tokens per request', scenarioA: formatTokens(resultA.tokensPerRequest), scenarioB: b((r) => formatTokens(r.tokensPerRequest)) },
    { label: 'Monthly tokens', scenarioA: formatTokens(resultA.monthlyTokens), scenarioB: b((r) => formatTokens(r.monthlyTokens)) },
    { label: 'Major cost driver', scenarioA: `${resultA.majorDriver} (${formatPercent(resultA.majorDriverShare * 100)})`, scenarioB: b((r) => `${r.majorDriver} (${formatPercent(r.majorDriverShare * 100)})`) },
  ];
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function serializeJson(state: TokenPlannerState): string {
  const resultA = calculateScenario(state.scenarioA, state.period);
  const resultB = state.compareEnabled ? calculateScenario(state.scenarioB, state.period) : null;
  const warnings = getThresholdWarnings(state, resultA, resultB);

  const payload = {
    generatedBy: 'Nixfred AI Systems Workbench, Token and Cost Planner',
    pricingEffectiveDate: PRICING_EFFECTIVE_DATE,
    boundary: 'These figures are planning estimates from the assumptions below. They are not a billing statement.',
    period: state.period,
    compareEnabled: state.compareEnabled,
    scenarioA: { inputs: state.scenarioA, result: resultA },
    scenarioB: state.compareEnabled ? { inputs: state.scenarioB, result: resultB } : null,
    warnings,
  };
  return JSON.stringify(payload, null, 2);
}

function serializeCsv(state: TokenPlannerState): string {
  const resultA = calculateScenario(state.scenarioA, state.period);
  const resultB = state.compareEnabled ? calculateScenario(state.scenarioB, state.period) : null;
  const rows = buildExportRows(state, resultA, resultB);

  const header = state.compareEnabled ? ['Metric', 'Scenario A', 'Scenario B'] : ['Metric', 'Scenario A'];
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) {
    const cells = state.compareEnabled
      ? [row.label, row.scenarioA, row.scenarioB ?? '']
      : [row.label, row.scenarioA];
    lines.push(cells.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

export const exportAdapter: ExportAdapter<TokenPlannerState> = {
  formats: ['json', 'csv'],
  serialize(state, format) {
    if (format === 'csv') return serializeCsv(state);
    if (format === 'markdown') {
      // Not offered on this tool's ExportBar, but the contract's union
      // includes it. Fall back to the JSON payload rather than throw.
      return serializeJson(state);
    }
    return serializeJson(state);
  },
  filename(state, format) {
    const extension = format === 'markdown' ? 'md' : format;
    return `token-cost-plan-${state.period}.${extension}`;
  },
};
