/**
 * Failure Investigator, diagnostic engine.
 *
 * PRD: tools-nixfred-prds/tools/11-FAILURE-INVESTIGATOR.md
 * User outcome: work backward from a bad AI system output to the
 * mechanism that produced it, then write the fix down.
 *
 * CONSOLIDATION (01-INFORMATION-ARCHITECTURE.md): "AI Failure Atlas and
 * AI Incident Room become Failure Investigator." This file supplies
 * both halves. A ranking engine that turns discriminating answers into
 * ranked hypotheses (the incident room, the walkthrough), and a static
 * catalog of failure mechanisms anyone can browse without answering a
 * single question (the atlas).
 *
 * HONESTY, the hard boundary from the PRD: "No claim of automatic root
 * cause certainty." This engine never asserts a cause. It scores every
 * mechanism against whatever evidence was supplied and reports a
 * ranked list with a confidence label, the matched evidence for and
 * against, and the next concrete check that would confirm or kill the
 * hypothesis. A questionnaire with a handful of answers cannot prove
 * anything, and nothing here is written as though it can.
 *
 * Pure functions only. No DOM, no globals, no I/O, and nothing here
 * ever executes a remediation. Every fix and every containment step is
 * text for a person to act on, never code this module runs.
 */

/* ------------------------------------------------------------------ *
 * Symptom categories
 *
 * PRD acceptance criterion: "Supports hallucination, retrieval,
 * permission, tool, latency, loop, and cost incidents." This is the
 * entry classification a user picks to orient the walkthrough. It does
 * not gate which mechanisms can be considered, since a hallucination
 * shaped complaint can turn out to be a retrieval or a tool problem
 * once the evidence comes in. Selecting a category is a starting
 * point, not a filter on the truth.
 * ------------------------------------------------------------------ */

export const SYMPTOM_CATEGORIES = [
  'hallucination',
  'retrieval',
  'permission',
  'tool',
  'latency',
  'loop',
  'cost',
] as const;
export type SymptomCategory = (typeof SYMPTOM_CATEGORIES)[number];

export const SYMPTOM_CATEGORY_LABELS: Record<SymptomCategory, string> = {
  hallucination: 'Hallucination',
  retrieval: 'Retrieval',
  permission: 'Permission or policy',
  tool: 'Tool or integration',
  latency: 'Latency',
  loop: 'Loop or repetition',
  cost: 'Cost',
};

export const SYMPTOM_CATEGORY_HINTS: Record<SymptomCategory, string> = {
  hallucination: 'A confident answer states something false or invented.',
  retrieval: 'A real fact exists somewhere but the answer misses it or gets it wrong.',
  permission: 'The system did something unauthorized, or refused something it should not have.',
  tool: 'A tool, function, or external call is part of the story.',
  latency: 'The response is correct but arrives too slowly.',
  loop: 'The system gets stuck repeating itself instead of finishing.',
  cost: 'The same task is costing more than it should.',
};

/**
 * Internal catalog tagging. A superset of the seven symptom categories
 * plus "reliability" for mechanisms that cut across all of them,
 * prompt conflicts, format drift, encoding, sampling variance, none of
 * which belongs to one incident type more than another.
 */
export const MECHANISM_CATEGORIES = [...SYMPTOM_CATEGORIES, 'reliability'] as const;
export type MechanismCategory = (typeof MECHANISM_CATEGORIES)[number];

export const MECHANISM_CATEGORY_LABELS: Record<MechanismCategory, string> = {
  ...SYMPTOM_CATEGORY_LABELS,
  reliability: 'General reliability',
};

/* ------------------------------------------------------------------ *
 * Discriminating questions
 *
 * PRD build brief: "Is it reproducible with the same input. Does it
 * fail at temperature 0. Did it fail on a long input only. Is the
 * wrong content plausible but false, or malformed, or a refusal, or
 * truncated. Does it degrade with conversation length." Those five are
 * present below. Four more (recent change, untrusted content, tool
 * involvement, fact checkability) exist because the sixteen mechanism
 * catalog below cannot be told apart without them, most importantly
 * telling a retrieval miss apart from an outright hallucination, and a
 * prompt injection apart from every other cause of unwanted behavior.
 * ------------------------------------------------------------------ */

export interface QuestionOption {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  prompt: string;
  hint: string;
  options: QuestionOption[];
}

export const QUESTIONS: Question[] = [
  {
    id: 'reproducible',
    prompt: 'Does the exact same input reliably reproduce the bad output?',
    hint: 'Try it two or three times with identical input before answering.',
    options: [
      { value: 'always', label: 'Yes, every time' },
      { value: 'sometimes', label: 'Only sometimes' },
      { value: 'unknown', label: 'Have not tried twice' },
    ],
  },
  {
    id: 'temperatureZero',
    prompt: 'Does it still fail at temperature 0, or the most deterministic setting available?',
    hint: 'This is the single fastest way to rule sampling randomness in or out.',
    options: [
      { value: 'stillFails', label: 'Yes, still fails at temperature 0' },
      { value: 'passes', label: 'No, it passes at temperature 0' },
      { value: 'notTried', label: 'Have not tried' },
    ],
  },
  {
    id: 'inputLength',
    prompt: 'Does it only fail on long input, or do short inputs fail too?',
    hint: 'A budget or positional limit only shows up once there is enough length to hit it.',
    options: [
      { value: 'longOnly', label: 'Long input only' },
      { value: 'shortToo', label: 'Short input fails too' },
      { value: 'notTried', label: 'Have not compared' },
    ],
  },
  {
    id: 'outputShape',
    prompt: 'What is actually wrong with the output?',
    hint: 'Pick the shape that matches best, even if more than one seems close.',
    options: [
      { value: 'plausibleFalse', label: 'It reads fine but states something false' },
      { value: 'malformed', label: 'It breaks the expected format or schema' },
      { value: 'refusal', label: 'It refuses a request that should be fine' },
      { value: 'truncated', label: 'It cuts off mid answer' },
      { value: 'repetitive', label: 'It repeats a phrase, sentence, or action in a loop' },
      { value: 'garbled', label: 'It contains garbled or mis encoded text' },
      { value: 'offTask', label: 'It did something nobody asked it to do' },
      { value: 'slow', label: 'The content is fine, but it is slow or costs too much' },
    ],
  },
  {
    id: 'conversationLength',
    prompt: 'Does the failure get worse as the conversation or document gets longer?',
    hint: 'Compare an early turn against a late one in the same session if you can.',
    options: [
      { value: 'degrades', label: 'Yes, it degrades with length' },
      { value: 'stable', label: 'No, length does not seem to matter' },
      { value: 'notTried', label: 'Have not compared' },
    ],
  },
  {
    id: 'recentChange',
    prompt: 'What changed most recently before this started happening?',
    hint: 'Pick the closest match. Pick nothing changed if you genuinely do not know of one.',
    options: [
      { value: 'promptChanged', label: 'The prompt or instructions' },
      { value: 'modelChanged', label: 'The model or its version' },
      { value: 'indexChanged', label: 'The retrieval index or knowledge source' },
      { value: 'toolChanged', label: 'A tool or API integration' },
      { value: 'nothing', label: 'Nothing we are aware of' },
    ],
  },
  {
    id: 'untrustedContent',
    prompt: 'Does the input include third party or user supplied text the model reads as context?',
    hint: 'A web page, an uploaded document, or a tool result all count.',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No, only our own instructions and data' },
    ],
  },
  {
    id: 'toolInvolved',
    prompt: 'Does producing this output involve a tool call, function call, or external API?',
    hint: 'Includes retrieval systems, since a retriever is a tool call from the model point of view.',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      { value: 'unknown', label: 'Not sure' },
    ],
  },
  {
    id: 'factCheckable',
    prompt:
      'If the wrong content is a specific fact, can you find that fact anywhere in the material the model had access to?',
    hint: 'This is the question that tells a retrieval miss apart from an invented detail.',
    options: [
      { value: 'notFound', label: 'No, it is not in any source we gave it' },
      { value: 'foundButWrong', label: 'It is in a source, but that source is outdated' },
      { value: 'notApplicable', label: 'Not applicable, or have not checked' },
    ],
  },
];

export type QuestionId = (typeof QUESTIONS)[number]['id'];

/** A partial record of answers. Every field is optional because the
 * walkthrough can be run with as few or as many answers as the user
 * actually has evidence for. */
export type Answers = Partial<Record<QuestionId, string>>;

/** How many questions currently carry an answer. Used both to gate the
 * ranked hypotheses panel and to cap confidence when evidence is thin. */
export function answeredCount(answers: Answers): number {
  return Object.values(answers).filter((v) => typeof v === 'string' && v.length > 0).length;
}

/* ------------------------------------------------------------------ *
 * Failure mechanism catalog
 *
 * PRD build brief: "Ship a real catalog of failure mechanisms." Every
 * entry states how it presents, the underlying reason, how to confirm
 * it, an immediate non destructive containment step, the durable fix,
 * and a regression test that would catch it next time. Every field is
 * required and non empty, enforced by tests/tool-failure-investigator.mjs.
 *
 * `signals` is the scoring data behind the ranked hypotheses panel. It
 * is not shown to the user directly; the evidence sentences it carries
 * are what surface in the for and against lists.
 * ------------------------------------------------------------------ */

export interface EvidenceCue {
  questionId: QuestionId;
  /** The answer value this cue fires on. */
  answer: string;
  /** Positive supports the mechanism, negative counts against it. */
  weight: number;
  /** The sentence shown in the evidence for or against list. */
  evidence: string;
}

/**
 * A containment step, always phrased as a proposal for a person to
 * weigh, never as a command this tool carries out. See the PRD
 * boundary "Destructive remediation is never auto executed": this
 * tool has no execution path at all, but the text itself must not
 * read like one either, so every proposal starts with "Consider" and
 * every entry states plainly whether it destroys or overwrites state
 * and, when it does, exactly what that costs and how to undo it.
 */
export interface ContainmentAction {
  /** Proposal phrasing. Never an instruction to execute without thought. */
  proposal: string;
  /** True when carrying this out would discard or overwrite state that
   * is not trivially recoverable, a cache flush, an index rollback, a
   * revoked credential. */
  destructive: boolean;
  /** Always populated, even when destructive is false, so the field is
   * never silently absent. States what is lost and how to undo it. */
  reversibility: string;
}

/** Standard reversibility statement for containment steps that add,
 * restrict, or delay rather than discard anything. Reused verbatim
 * across every non destructive mechanism since the underlying fact is
 * the same in every case: nothing existing is destroyed. */
const NOT_DESTRUCTIVE =
  'Not destructive. This step only limits, delays, or adds information going forward. Nothing existing is deleted or overwritten, so there is nothing to undo.';

export interface Mechanism {
  id: string;
  name: string;
  category: MechanismCategory;
  /** How it presents to whoever is looking at the output. */
  presentsAs: string;
  /** The underlying reason the failure happens at all. */
  underlyingReason: string;
  /** A concrete check that would confirm or rule this out. */
  howToConfirm: string;
  /** An immediate mitigation, proposed rather than instructed, never
   * executed by this tool. */
  containment: ContainmentAction;
  /** The durable fix, once the mechanism is confirmed. */
  durableFix: string;
  /** A regression test that would catch a recurrence. */
  suggestedRegressionTest: string;
  signals: EvidenceCue[];
}

export const MECHANISMS: Mechanism[] = [
  {
    id: 'context-truncation',
    name: 'Context truncation',
    category: 'reliability',
    presentsAs:
      'The model behaves as if it never saw something given earlier in a long input or a long running conversation, or its own answer stops abruptly mid thought. Both are symptoms of the same fixed context budget being exceeded.',
    underlyingReason:
      'The pipeline has a fixed context budget. Once the input plus the running conversation exceeds it, something has to be dropped, usually the oldest turns or the earliest part of a long document, and the drop happens silently.',
    howToConfirm:
      'Log the exact token count sent to the model for the failing turn and compare it against the context limit. Then check whether the missing fact sits in the part of the input that would have been trimmed first.',
    containment: {
      proposal:
        'Consider shortening the input or conversation for the next attempt by summarizing or removing older turns, and restating the load bearing fact right before the question so it survives regardless of what else gets trimmed.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Track a real token budget for every request, summarize or drop content on purpose instead of by accident, and keep the instructions and facts the answer depends on inside the part of the window that always survives.',
    suggestedRegressionTest:
      'Add a test that grows the input or the conversation past the known budget with a specific fact placed near the start, and assert the fact still appears in the answer once the total crosses that boundary.',
    signals: [
      { questionId: 'reproducible', answer: 'always', weight: 2, evidence: 'Reproduces every time, which fits a fixed structural limit more than a random one.' },
      { questionId: 'reproducible', answer: 'sometimes', weight: -1, evidence: 'Only reproduces sometimes, which a hard budget limit alone would not usually produce.' },
      { questionId: 'temperatureZero', answer: 'stillFails', weight: 2, evidence: 'Still fails at temperature 0, ruling out sampling as the explanation.' },
      { questionId: 'temperatureZero', answer: 'passes', weight: -3, evidence: 'Passes at temperature 0, which points at randomness rather than a fixed budget limit.' },
      { questionId: 'inputLength', answer: 'longOnly', weight: 3, evidence: 'Only fails once the input gets long, matching a fixed context budget being exceeded.' },
      { questionId: 'inputLength', answer: 'shortToo', weight: -3, evidence: 'Also fails on short input, which a context budget limit would not explain.' },
      { questionId: 'conversationLength', answer: 'degrades', weight: 3, evidence: 'Gets worse as the conversation grows, consistent with older turns falling out of the window.' },
      { questionId: 'conversationLength', answer: 'stable', weight: -2, evidence: 'Does not get worse with length, which argues against a budget limit.' },
      { questionId: 'recentChange', answer: 'promptChanged', weight: 1, evidence: 'The prompt changed recently, which can shrink the budget left over for everything else.' },
      { questionId: 'outputShape', answer: 'truncated', weight: 3, evidence: 'The response itself cuts off mid answer, the most direct symptom of hitting a context or output limit.' },
    ],
  },
  {
    id: 'lost-in-the-middle',
    name: 'Lost in the middle',
    category: 'retrieval',
    presentsAs:
      'A fact placed in the middle of a long input or a long set of retrieved passages gets ignored or garbled, while the same kind of fact placed at the very start or the very end is handled correctly.',
    underlyingReason:
      'Long context handling has a well documented positional bias. Attention over a long input is strongest near the beginning and the end and weakest in the middle, so a true and present fact can still be missed if it lands in the weak zone.',
    howToConfirm:
      'Move the suspect fact to the start or the end of the same input and rerun with nothing else changed. If the answer improves, position was the cause, not the presence of the fact.',
    containment: {
      proposal:
        'Consider reordering the current input so the fact the answer depends on sits near the start or the end rather than buried in the middle, until the pipeline itself is fixed.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Rank and place the most decision relevant passages near the start or end of the context, or restate the key facts again right before the question rather than relying on one mention buried mid document.',
    suggestedRegressionTest:
      'Add a test that inserts a known fact at several positions across a long context, front, middle, and end, and assert the answer uses the fact correctly at every position.',
    signals: [
      { questionId: 'inputLength', answer: 'longOnly', weight: 2, evidence: 'Only fails on long input, consistent with a positional effect that needs enough length to show up.' },
      { questionId: 'inputLength', answer: 'shortToo', weight: -2, evidence: 'Also fails on short input, which a purely positional effect would not explain.' },
      { questionId: 'reproducible', answer: 'always', weight: 2, evidence: 'Reproduces every time in the same position, matching a structural attention pattern rather than noise.' },
      { questionId: 'temperatureZero', answer: 'stillFails', weight: 2, evidence: 'Still fails at temperature 0, ruling out sampling as the sole explanation.' },
      { questionId: 'temperatureZero', answer: 'passes', weight: -2, evidence: 'Passes at temperature 0, which argues for randomness over a positional pattern.' },
      { questionId: 'conversationLength', answer: 'degrades', weight: 1, evidence: 'Getting worse with length fits more content competing for the same weak middle zone.' },
    ],
  },
  {
    id: 'retrieval-miss',
    name: 'Retrieval miss',
    category: 'retrieval',
    presentsAs:
      'The answer is missing a fact that genuinely exists in the knowledge source, or states the opposite of it, even though a retrieval step ran.',
    underlyingReason:
      'The retriever never returned the passage that contains the fact. The embedding for the query did not land near the right passage, the passage was split across a chunk boundary, or the ranked list simply did not include it.',
    howToConfirm:
      'Log the exact passages the retriever returned for this query and check whether the fact appears in any of them. If it does not, the retriever failed before the model ever had a chance.',
    containment: {
      proposal:
        'Consider rerunning the same question with a manually supplied version of the correct passage, to confirm the model would have answered correctly with better retrieval, and flagging the query for a widened search in the meantime.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Improve chunking so a fact is not split across a boundary, rewrite or expand the query before embedding it, and raise the number of candidates considered before the final rank.',
    suggestedRegressionTest:
      'Add a retrieval only test, no model call, that embeds the known query and asserts the passage containing the fact appears in the top results.',
    signals: [
      { questionId: 'toolInvolved', answer: 'yes', weight: 2, evidence: 'A retrieval or tool step is part of this pipeline, a precondition for a retrieval miss.' },
      { questionId: 'toolInvolved', answer: 'no', weight: -3, evidence: 'No retrieval or tool step exists in this pipeline, so a retrieval miss cannot be the cause.' },
      { questionId: 'factCheckable', answer: 'notFound', weight: 1, evidence: 'The fact cannot be found in the material the model had, though a retrieval step exists that could have surfaced it.' },
      { questionId: 'outputShape', answer: 'plausibleFalse', weight: 2, evidence: 'The answer reads fine but states something false, matching a fact that was simply never surfaced.' },
      { questionId: 'reproducible', answer: 'always', weight: 1, evidence: 'Reproduces every time, matching a fixed retrieval result rather than random variation.' },
    ],
  },
  {
    id: 'stale-index',
    name: 'Stale index',
    category: 'retrieval',
    presentsAs:
      'The answer states a fact that used to be correct and reads as fully confident, but the underlying source changed and the index the retriever searches did not.',
    underlyingReason:
      'A retrieval index is a copy of the source taken at some point in time. If the source changes and nothing rebuilds or invalidates the index, retrieval keeps returning the old copy as if it were current.',
    howToConfirm:
      'Compare the timestamp or version on the retrieved passage against the current version of the source document. A mismatch confirms the index is behind the source.',
    containment: {
      proposal:
        'Consider rolling the index back to the last known good snapshot for this fact while a fresh rebuild is confirmed, or pinning a manual override for this one fact if a full rollback is too disruptive. This is a destructive step, marked below, because rolling back an index is not the same as pinning one fact.',
      destructive: true,
      reversibility:
        'Reversible in the sense that no source data is deleted, only which index snapshot answers queries. It is not free: rolling back also rolls back any real, correct updates the index had already picked up since that snapshot, so anything genuinely new in that window goes stale again until the index is rebuilt forward.',
    },
    durableFix:
      'Rebuild or invalidate the index automatically whenever the source changes, and show the index build time somewhere so a stale answer is diagnosable at a glance.',
    suggestedRegressionTest:
      'Add a test that updates a source fixture, triggers the same reindex path used in production, and asserts a query against the new fact returns the new value, not the old one.',
    signals: [
      { questionId: 'factCheckable', answer: 'foundButWrong', weight: 3, evidence: 'The fact is present in a source, but that source is outdated, the exact signature of a stale index.' },
      { questionId: 'toolInvolved', answer: 'yes', weight: 1, evidence: 'A retrieval step exists, a precondition for an index being able to go stale at all.' },
      { questionId: 'reproducible', answer: 'always', weight: 2, evidence: 'The same outdated answer comes back every time, matching a fixed stale copy rather than randomness.' },
      { questionId: 'recentChange', answer: 'indexChanged', weight: -1, evidence: 'The index was recently rebuilt, which argues against it being stale right now.' },
      { questionId: 'recentChange', answer: 'nothing', weight: 1, evidence: 'Nothing was knowingly changed on the system side, which fits a source that moved while the index sat still.' },
    ],
  },
  {
    id: 'prompt-injection',
    name: 'Prompt injection',
    category: 'permission',
    presentsAs:
      'The system follows an instruction that was never given by the user or the operator. It came from inside content the system was only supposed to read, a web page, a document, or a tool result.',
    underlyingReason:
      'Nothing in the prompt structure marks that third party content as data rather than instructions, so an imperative sentence embedded in it is read with the same authority as a real instruction.',
    howToConfirm:
      'Reread the third party content for imperative language, then rerun the same task with that content sanitized or stripped of imperative phrasing. If the behavior disappears, injection is confirmed.',
    containment: {
      proposal:
        'Consider pausing that specific source from reaching the model until it is sanitized, and reviewing anything the system already acted on that came from it.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Wrap untrusted content in a clearly delimited block the system prompt names explicitly as data, strip or neutralize imperative phrasing before it reaches the model, and give operator instructions higher standing than anything found inside fetched content.',
    suggestedRegressionTest:
      'Add a test that feeds a fixture document containing a hidden instruction and asserts the system never performs the hidden instruction, only the one the user actually asked for.',
    signals: [
      { questionId: 'untrustedContent', answer: 'yes', weight: 3, evidence: 'Untrusted third party content is part of the input, the precondition for an injection to occur.' },
      { questionId: 'untrustedContent', answer: 'no', weight: -3, evidence: 'No third party content is involved, so there is nothing for an injection to hide inside.' },
      { questionId: 'outputShape', answer: 'offTask', weight: 3, evidence: 'The system did something nobody asked it to do, the signature symptom of an injected instruction.' },
      { questionId: 'reproducible', answer: 'always', weight: 1, evidence: 'Reproduces every time the same content is used, matching a fixed instruction sitting inside that content.' },
    ],
  },
  {
    id: 'instruction-conflict',
    name: 'Instruction conflict',
    category: 'reliability',
    presentsAs:
      'The output satisfies one of two contradictory instructions in the prompt and not the other, and which one wins is not consistent from run to run.',
    underlyingReason:
      'The prompt asks for two things that cannot both be true at once, brief and thorough, only this and also that, and the model resolves the contradiction on its own, differently each time.',
    howToConfirm:
      'Read the exact system and task text for a pair of directives that cannot both hold, then test each directive alone to see whether it is satisfiable by itself.',
    containment: {
      proposal:
        'Consider picking one of the two conflicting directives by hand for the next request, and setting the other aside, until the prompt itself is corrected.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Resolve the contradiction explicitly in the prompt, state a single priority when two goals trade off, and remove or scope the directive that cannot always be honored.',
    suggestedRegressionTest:
      'Add a test that runs the exact prompt several times and asserts the same one of the two conflicting directives wins every time, or asserts the conflict has been removed from the prompt entirely.',
    signals: [
      { questionId: 'reproducible', answer: 'sometimes', weight: 3, evidence: 'The outcome varies across runs of the same input, fitting two directives that cannot both be satisfied at once.' },
      { questionId: 'reproducible', answer: 'always', weight: -2, evidence: 'The same outcome happens every time, which argues against an unresolved conflict picking a side at random.' },
      { questionId: 'recentChange', answer: 'promptChanged', weight: 2, evidence: 'The prompt changed recently, which is when a new contradictory directive is usually introduced.' },
    ],
  },
  {
    id: 'format-drift',
    name: 'Format drift',
    category: 'reliability',
    presentsAs:
      'Output that is supposed to conform to a strict format, JSON, a schema, a fixed template, breaks that format on some requests and not others, often on the longer or more complex ones.',
    underlyingReason:
      'Nothing in the pipeline actually enforces the format. The model is asked nicely to produce it as free text, and free text generation can drift away from a strict shape the longer or more complicated the answer gets.',
    howToConfirm:
      'Compare a passing and a failing example side by side for length and complexity, and check whether the call uses any schema or grammar constrained decoding at all.',
    containment: {
      proposal:
        'Consider validating every output against the schema before using it, and rejecting or retrying the ones that fail rather than passing broken output further down the pipeline.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Use schema constrained or grammar constrained decoding where the provider supports it, and add a validate and retry step for the paths that do not.',
    suggestedRegressionTest:
      'Add a test that runs the same schema constrained request across a range of input lengths and asserts every response parses against the schema, not just the short ones.',
    signals: [
      { questionId: 'outputShape', answer: 'malformed', weight: 3, evidence: 'The output breaks its expected format, the direct symptom of format drift.' },
      { questionId: 'inputLength', answer: 'longOnly', weight: 2, evidence: 'Only breaks on longer input or output, matching free text drifting further from the shape the longer it runs.' },
      { questionId: 'reproducible', answer: 'sometimes', weight: 1, evidence: 'Not fully consistent across runs, fitting unconstrained generation rather than a hard rule.' },
      { questionId: 'recentChange', answer: 'modelChanged', weight: 1, evidence: 'The model changed recently, and format adherence commonly shifts across model versions when nothing enforces the shape.' },
    ],
  },
  {
    id: 'hallucinated-specifics',
    name: 'Hallucinated specifics',
    category: 'hallucination',
    presentsAs:
      'A fluent, confident answer contains a specific detail, a citation, a number, a name, that sounds exactly right and is not real.',
    underlyingReason:
      'Nothing in the available context grounds that specific detail, so the model fills the gap with the most statistically plausible sounding content rather than saying it does not know.',
    howToConfirm:
      'Search every piece of material the model actually had access to for the specific claim. If it is not there, and there is no retrieval step at all, the detail was invented rather than retrieved wrong.',
    containment: {
      proposal:
        'Consider flagging the specific claim as unverified for the reader right now, and holding off on repeating it as fact until it is checked against a real source.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Require the model to ground specific claims in supplied material and say so when it cannot, add retrieval where none exists, and lower the temperature on tasks where a specific wrong detail is costly.',
    suggestedRegressionTest:
      'Add a test that asks for a specific detail the model was never given and asserts the response says it does not know rather than inventing one.',
    signals: [
      { questionId: 'toolInvolved', answer: 'no', weight: 2, evidence: 'No retrieval or tool step exists in this pipeline, so a specific wrong fact has nowhere to come from except invention.' },
      { questionId: 'toolInvolved', answer: 'yes', weight: -2, evidence: 'A retrieval step exists, so a wrong fact is more likely a retrieval miss than a pure invention.' },
      { questionId: 'factCheckable', answer: 'notFound', weight: 2, evidence: 'The specific claim cannot be found anywhere in the material the model had access to.' },
      { questionId: 'outputShape', answer: 'plausibleFalse', weight: 2, evidence: 'The answer reads fine but states something false, matching a fabricated detail rather than a formatting problem.' },
      { questionId: 'temperatureZero', answer: 'passes', weight: -1, evidence: 'Passes at temperature 0, which argues for sampling variance over a grounding gap that would persist regardless of temperature.' },
    ],
  },
  {
    id: 'refusal-overbroad-safety',
    name: 'Overbroad refusal',
    category: 'permission',
    presentsAs:
      'The system declines a request that is actually benign, citing a safety or policy reason that does not really apply to what was asked.',
    underlyingReason:
      'A safety instruction in the system prompt is written broadly enough to pattern match on surface keywords rather than the actual risk, so it fires on legitimate requests that merely resemble a risky one.',
    howToConfirm:
      'Read the exact safety language in the system prompt, then rerun a minimally reworded version of the same request that avoids the trigger phrase. If it succeeds, the trigger was the surface wording, not the actual risk.',
    containment: {
      proposal:
        'Consider rephrasing the specific request to avoid the trigger phrase as an immediate workaround, and noting the false refusal for whoever owns the safety language.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Narrow the safety instruction to the condition that actually represents risk, add explicit exceptions for the legitimate cases it currently blocks, and test it against a set of benign requests that resemble risky ones.',
    suggestedRegressionTest:
      'Add a test suite of benign requests that resemble risky ones by surface wording, and assert none of them are refused.',
    signals: [
      { questionId: 'outputShape', answer: 'refusal', weight: 3, evidence: 'The system refused a request, the direct symptom of an overbroad safety instruction.' },
      { questionId: 'reproducible', answer: 'always', weight: 2, evidence: 'The refusal happens every time, matching a fixed rule rather than an occasional misjudgment.' },
      { questionId: 'recentChange', answer: 'promptChanged', weight: 2, evidence: 'The prompt or its safety language changed recently, which is when a new overbroad rule is usually introduced.' },
    ],
  },
  {
    id: 'tokenizer-encoding',
    name: 'Tokenizer or encoding issue',
    category: 'reliability',
    presentsAs:
      'Output contains garbled or mis encoded characters, or a task that depends on exact character counting or exact character level editing comes out wrong, especially with non English text, emoji, or unusual formatting.',
    underlyingReason:
      'Text is broken into tokens that do not line up one to one with characters or words. A counting or character level task assumes a mapping the tokenizer does not actually provide, and multi byte encodings can be mishandled by whatever converts text at the edges of the pipeline.',
    howToConfirm:
      'Check whether the input contains non ASCII text or unusual whitespace, and check whether the task requires exact character level counting or editing rather than a task about meaning.',
    containment: {
      proposal:
        'Consider moving the character level part of the task to ordinary code rather than asking the model to do it, as an immediate workaround for this request.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Preprocess and normalize text encoding before it enters the pipeline, and hand off exact counting or character level editing to deterministic code instead of asking a language model to do it.',
    suggestedRegressionTest:
      'Add a test with non ASCII input and a character counting or editing task, and assert the result matches a programmatic count rather than the model reported one.',
    signals: [
      { questionId: 'outputShape', answer: 'garbled', weight: 3, evidence: 'The output itself contains garbled or mis encoded text, the direct symptom of an encoding problem.' },
      { questionId: 'reproducible', answer: 'always', weight: 2, evidence: 'Reproduces every time with the same input, matching a structural encoding issue rather than noise.' },
      { questionId: 'temperatureZero', answer: 'stillFails', weight: 1, evidence: 'Still fails at temperature 0, ruling out sampling as the explanation.' },
    ],
  },
  {
    id: 'nondeterminism-temperature',
    name: 'Sampling nondeterminism',
    category: 'reliability',
    presentsAs:
      'The exact same input sometimes produces a good answer and sometimes a bad one, with nothing else about the code, the data, or the prompt having changed.',
    underlyingReason:
      'A nonzero sampling temperature or top p setting means the model draws from a distribution rather than always taking the single most likely continuation, so a low probability bad continuation gets drawn occasionally.',
    howToConfirm:
      'Run the identical input many times and tabulate the failure rate, then rerun the same set at temperature 0. If the failures disappear at temperature 0, sampling is confirmed as the cause.',
    containment: {
      proposal:
        'Consider lowering the temperature for this task, or adding a simple retry on a failed output, until a permanent decision is made about how much variance the task can tolerate.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Set temperature deliberately per task instead of leaving a default, add automated validation and retry for tasks where any variance is unacceptable, and treat some amount of variance as expected when full determinism was never actually required.',
    suggestedRegressionTest:
      'Add a test that samples the same input a fixed number of times at the production temperature and asserts the failure rate stays under an agreed threshold, plus a separate test confirming the failure disappears at temperature 0.',
    signals: [
      { questionId: 'reproducible', answer: 'sometimes', weight: 3, evidence: 'Only reproduces sometimes with identical input, the direct symptom of sampling variance.' },
      { questionId: 'reproducible', answer: 'always', weight: -3, evidence: 'Reproduces every time, which argues against sampling variance as the explanation.' },
      { questionId: 'temperatureZero', answer: 'passes', weight: 3, evidence: 'Passes at temperature 0, the clearest possible confirmation that sampling variance was the cause.' },
      { questionId: 'temperatureZero', answer: 'stillFails', weight: -3, evidence: 'Still fails at temperature 0, which rules out sampling variance entirely.' },
    ],
  },
  {
    id: 'cache-staleness',
    name: 'Cache staleness',
    category: 'tool',
    presentsAs:
      'A response that used to be wrong keeps coming back even after the prompt or the model was supposedly fixed, or a request that should differ from an earlier one gets the same answer anyway.',
    underlyingReason:
      'A caching layer, a semantic cache, a prompt cache, a CDN, returns a previously stored response keyed on something that does not actually capture what changed between the two requests.',
    howToConfirm:
      'Bypass the cache directly and rerun the request, and compare the cache key actually used against what really differs between the case that should have changed and the one that did not.',
    containment: {
      proposal:
        'Consider flushing or bypassing the cache for this specific key while the key design is reviewed. This is a destructive step, marked below, though a low risk one.',
      destructive: true,
      reversibility:
        'Reversible. A flushed cache repopulates itself from the next request; nothing about the underlying source is deleted, only the temporary copy of it. The cost is a slower response for whichever requests land while it refills, not a permanent loss.',
    },
    durableFix:
      'Version the cache key on the prompt version and the model version, invalidate on deploy, and exclude anything from the key that should always produce a fresh response.',
    suggestedRegressionTest:
      'Add a test that changes exactly the part of the request the cache key should depend on, and asserts the response changes too, not just that the cache returns quickly.',
    signals: [
      { questionId: 'reproducible', answer: 'always', weight: 2, evidence: 'The identical response comes back every time even where variation was expected, matching a cache returning the same stored value.' },
      { questionId: 'recentChange', answer: 'nothing', weight: 2, evidence: 'Nothing was knowingly changed, and yet behavior that should have updated did not, fitting a cache that outlived the thing it was keyed on.' },
      { questionId: 'recentChange', answer: 'promptChanged', weight: 1, evidence: 'The prompt changed recently but the old behavior persisted anyway, consistent with a cache key that does not include the prompt version.' },
      { questionId: 'toolInvolved', answer: 'yes', weight: 1, evidence: 'An external layer sits between the request and the model, which is often where a cache is implemented.' },
    ],
  },
  {
    id: 'tool-error-swallowed',
    name: 'Tool error swallowed',
    category: 'tool',
    presentsAs:
      'The system narrates as if a tool call, an API call, a function call, succeeded, when the call actually errored, timed out, or returned nothing.',
    underlyingReason:
      'The orchestration code around the model catches the failure, a timeout, an exception, an empty result, but never surfaces it back into the context, so the model has no signal that anything went wrong and continues as if it worked.',
    howToConfirm:
      'Check the tool or function call logs for that exact turn for a non success status, a timeout, or an empty result, independent of what the model said happened.',
    containment: {
      proposal:
        'Consider telling the affected user directly that the action may not have completed and asking them to verify it, rather than trusting the narration.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Propagate every tool failure into the context explicitly as a failure the model must react to, and never let orchestration code hide an error from the model that is supposed to reason about what happened.',
    suggestedRegressionTest:
      'Add a test that forces the tool call to fail and asserts the model response states the action did not complete rather than claiming success.',
    signals: [
      { questionId: 'toolInvolved', answer: 'yes', weight: 3, evidence: 'A tool or API call is part of producing this output, a precondition for a swallowed tool error.' },
      { questionId: 'toolInvolved', answer: 'no', weight: -3, evidence: 'No tool or API call is involved, so there is no tool error to swallow.' },
      { questionId: 'outputShape', answer: 'plausibleFalse', weight: 2, evidence: 'The output reads as a normal success, matching a model that was never told anything failed.' },
      { questionId: 'reproducible', answer: 'sometimes', weight: 1, evidence: 'Only reproduces sometimes, matching an intermittent upstream failure rather than a constant one.' },
    ],
  },
  {
    id: 'loop-repetition-collapse',
    name: 'Loop or repetition collapse',
    category: 'loop',
    presentsAs:
      'The output gets stuck repeating the same phrase, sentence, or tool call over and over instead of finishing, or an agent keeps reissuing the same action.',
    underlyingReason:
      'Degenerate sampling can fall into a repetitive attractor, and an agent loop with no real termination condition will keep reissuing the same step it already tried, especially once the first attempt already failed once.',
    howToConfirm:
      'Check the raw transcript for literal repeated phrases or repeated identical tool calls, and check whether the agent loop has an explicit stop condition or a step limit at all.',
    containment: {
      proposal:
        'Consider cutting the response or the loop off at a hard step limit rather than letting it run further, and surfacing the partial result instead of the repeated one.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Add a repetition detector that halts generation, and give every agent loop an explicit termination condition and a hard maximum number of steps rather than relying on the model to decide when to stop.',
    suggestedRegressionTest:
      'Add a test that forces the conditions known to trigger the loop, and asserts execution halts at the step limit rather than repeating past it.',
    signals: [
      { questionId: 'outputShape', answer: 'repetitive', weight: 3, evidence: 'The output itself repeats a phrase or an action, the direct symptom of a repetition collapse.' },
      { questionId: 'conversationLength', answer: 'degrades', weight: 1, evidence: 'Gets worse the longer the run goes, matching a loop that compounds the longer it is allowed to continue.' },
      { questionId: 'reproducible', answer: 'sometimes', weight: 1, evidence: 'Only reproduces sometimes, matching a loop that depends on how a run happens to unfold rather than a fixed rule.' },
      { questionId: 'toolInvolved', answer: 'yes', weight: 1, evidence: 'A tool or agent loop is involved, which is where a repeated action loop would show up.' },
    ],
  },
  {
    id: 'serial-dependency-latency',
    name: 'Serial dependency latency',
    category: 'latency',
    presentsAs:
      'Every request takes about the same long time regardless of how simple or complex the actual question is, and the wait does not scale with the work being done.',
    underlyingReason:
      'Stages that could run independently are chained one after another instead, or a single slow upstream dependency, an embedding service, a tool API, sits on the critical path with nothing timed out or cached around it.',
    howToConfirm:
      'Add per stage timing to the request and look at where the wall clock actually goes, rather than guessing which stage is slow.',
    containment: {
      proposal:
        'Consider adding a timeout with a faster fallback path for the slow dependency, so one slow stage cannot hold up the whole response.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Parallelize the stages that do not actually depend on each other, cache or pre warm the slow dependency, and set a timeout with a defined fallback for anything on the critical path.',
    suggestedRegressionTest:
      'Add a test that measures per stage latency for a simple and a complex request, and asserts the simple one is meaningfully faster, not the same fixed time as the complex one.',
    signals: [
      { questionId: 'outputShape', answer: 'slow', weight: 3, evidence: 'The complaint is that responses are slow or costly rather than wrong, the direct symptom of a latency problem.' },
      { questionId: 'toolInvolved', answer: 'yes', weight: 2, evidence: 'A tool or external call is part of the pipeline, often where an uncached or unparallelized dependency lives.' },
      { questionId: 'recentChange', answer: 'toolChanged', weight: 2, evidence: 'A tool or integration changed recently, a common source of a newly slow dependency.' },
      { questionId: 'reproducible', answer: 'always', weight: 1, evidence: 'The same long wait happens every time, matching a fixed serial chain rather than an occasional spike.' },
    ],
  },
  {
    id: 'unbounded-output-cost',
    name: 'Unbounded output cost',
    category: 'cost',
    presentsAs:
      'The same kind of task costs noticeably more than it used to, mostly in output tokens rather than input, even though the volume of work has not changed.',
    underlyingReason:
      'Nothing caps how much the model produces or how many times a failed attempt gets retried, so completions run longer than the task needs and a retry storm resends the same expensive context repeatedly.',
    howToConfirm:
      'Compare input tokens against output tokens in the usage log for a sample of the expensive requests, and check the retry count for the same requests.',
    containment: {
      proposal:
        'Consider capping the maximum output length for this task as an immediate ceiling on cost while the real cause is confirmed.',
      destructive: false,
      reversibility: NOT_DESTRUCTIVE,
    },
    durableFix:
      'Set an explicit maximum token or stop condition sized to the task, cap the number of retries, and avoid resending the full context on every retry attempt.',
    suggestedRegressionTest:
      'Add a test that runs the task and asserts output token count and retry count both stay under an agreed ceiling.',
    signals: [
      { questionId: 'outputShape', answer: 'slow', weight: 3, evidence: 'The complaint is about cost or slowness rather than wrong content, matching an output or retry volume problem.' },
      { questionId: 'recentChange', answer: 'promptChanged', weight: 2, evidence: 'The prompt changed recently, a common way a task starts asking for more output than before.' },
      { questionId: 'recentChange', answer: 'nothing', weight: 1, evidence: 'Nothing else changed, which points at a runaway parameter, an uncapped max tokens or retry count, rather than a code change.' },
    ],
  },
  {
    id: 'excess-agency',
    name: 'Excess agency',
    category: 'permission',
    presentsAs:
      'The system carries out an action within its technical reach that the task never called for, a write where only a read was needed, a broader scope than the request justified, with no injected instruction or trick involved at all.',
    underlyingReason:
      'The agent was granted more authority than the task requires, by design, usually because scoping permissions precisely is more work than granting a broad role once. Nothing forces the model to stay inside the narrower need, so it uses whatever the grant allows whenever acting on it seems locally helpful.',
    howToConfirm:
      'Compare the permission grant the agent actually holds against the narrowest set of actions the task could have needed, and check whether the specific action taken falls outside that narrower set even though it was within the broader grant.',
    containment: {
      proposal:
        'Consider revoking or suspending the broader permission grant for this agent while a narrower one is defined. This is a destructive step, marked below, because the agent will be unable to act at all in the meantime.',
      destructive: true,
      reversibility:
        'Reversible. The grant can be restored once a narrower scope is defined, but the agent cannot perform its normal job while suspended, so this is a real operational tradeoff, not a free action.',
    },
    durableFix:
      'Scope every agent to the narrowest permission set its task actually needs, require a separate elevated grant for anything wider, and log every action against what the task requested so an overreach is visible before it compounds.',
    suggestedRegressionTest:
      'Add a test that grants the agent its production permission set, gives it a narrow task, and asserts every action it takes falls within the subset that task actually required, not merely within the full grant.',
    signals: [
      { questionId: 'outputShape', answer: 'offTask', weight: 2, evidence: 'The system did something nobody asked it to do, matching an action outside the narrower scope the task actually needed.' },
      { questionId: 'untrustedContent', answer: 'no', weight: 2, evidence: 'No third party content is involved, which rules out injection and points at the agent\'s own standing authority instead.' },
      { questionId: 'untrustedContent', answer: 'yes', weight: -2, evidence: 'Third party content is involved, which is better explained as an injected instruction than as the agent\'s own excess authority.' },
      { questionId: 'toolInvolved', answer: 'yes', weight: 2, evidence: 'A tool or action capability is part of this pipeline, a precondition for excess agency to have anything to reach for.' },
      { questionId: 'reproducible', answer: 'always', weight: 1, evidence: 'Reproduces every time the same task is given, matching a standing grant rather than an injected one time trick.' },
    ],
  },
];

export function getMechanism(id: string): Mechanism | undefined {
  return MECHANISMS.find((m) => m.id === id);
}

/** Full text search plus an optional category filter, for the
 * browsable catalog half of the tool. Matches on name and every
 * prose field so a search for "cache" or "temperature 0" finds the
 * mechanism it describes even outside the name. */
export function searchMechanisms(query: string, category: MechanismCategory | 'all'): Mechanism[] {
  const q = query.trim().toLowerCase();
  return MECHANISMS.filter((m) => {
    if (category !== 'all' && m.category !== category) return false;
    if (!q) return true;
    const haystack = `${m.name} ${m.presentsAs} ${m.underlyingReason} ${m.howToConfirm} ${m.durableFix}`.toLowerCase();
    return haystack.includes(q);
  });
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

export type Confidence = 'low' | 'moderate' | 'high';

export interface Hypothesis {
  mechanismId: string;
  name: string;
  category: MechanismCategory;
  score: number;
  confidence: Confidence;
  evidenceFor: string[];
  evidenceAgainst: string[];
  /** A concrete next check, always the mechanism's howToConfirm text,
   * so it is guaranteed present even when no evidence has fired yet. */
  nextDiagnostic: string;
  containment: ContainmentAction;
}

/**
 * Scores every mechanism in the catalog against whatever answers are
 * present and returns them ALL, ranked highest score first.
 *
 * HONESTY BY CONSTRUCTION: this never throws, and it never omits a
 * mechanism. An empty or self contradicting answer set still returns
 * every mechanism, most of them at or near zero, each labeled
 * accordingly, rather than crashing or silently narrowing the field.
 * Confidence is capped at "low" until at least three questions carry
 * an answer, because a ranking built on one or two answers is not
 * something to call moderate or high, whatever the arithmetic says.
 *
 * This is the complete, unfiltered engine output, used internally and
 * by tests that need to see every mechanism regardless of evidence.
 * The UI and buildPostmortem do not render this directly, see
 * visibleHypotheses below.
 */
export function diagnose(answers: Answers): Hypothesis[] {
  const answered = answeredCount(answers);

  const hypotheses: Hypothesis[] = MECHANISMS.map((mechanism) => {
    let score = 0;
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    let maxPositive = 0;

    for (const cue of mechanism.signals) {
      if (cue.weight > 0) maxPositive += cue.weight;
      const given = answers[cue.questionId];
      if (given === undefined || given !== cue.answer) continue;
      score += cue.weight;
      if (cue.weight >= 0) evidenceFor.push(cue.evidence);
      else evidenceAgainst.push(cue.evidence);
    }

    const normalized = maxPositive > 0 ? score / maxPositive : 0;

    let confidence: Confidence = 'low';
    if (answered >= 3 && evidenceAgainst.length === 0 && normalized >= 0.6) {
      confidence = 'high';
    } else if (answered >= 2 && normalized > 0.2) {
      confidence = 'moderate';
    }

    return {
      mechanismId: mechanism.id,
      name: mechanism.name,
      category: mechanism.category,
      score,
      confidence,
      evidenceFor,
      evidenceAgainst,
      nextDiagnostic: mechanism.howToConfirm,
      containment: mechanism.containment,
    };
  });

  hypotheses.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hypotheses;
}

/**
 * The ranked hypotheses actually shown to a user, per PRD acceptance
 * criterion "No hypothesis is ranked without visible evidence."
 *
 * diagnose() above returns every mechanism unconditionally, including
 * ones with zero matched evidence (nothing answered yet touches them).
 * That is correct for the engine, which must never silently drop a
 * mechanism, but it is wrong for a RANKING presented to a person: a
 * mechanism with an empty evidenceFor and an empty evidenceAgainst has
 * not actually been ranked against anything, it is just sitting at the
 * bottom by default. This function is the one honesty boundary: a
 * hypothesis appears here if and only if at least one cue, for or
 * against, actually fired for it. Every question in QUESTIONS carries
 * at least one cue somewhere in the catalog, so answering any single
 * question guarantees this list is non empty.
 */
export function visibleHypotheses(answers: Answers): Hypothesis[] {
  return diagnose(answers).filter((h) => h.evidenceFor.length > 0 || h.evidenceAgainst.length > 0);
}

/* ------------------------------------------------------------------ *
 * Postmortem
 *
 * PRD outputs: "Ranked hypotheses, evidence for and against, next
 * checks, containment actions, and incident notes." The postmortem
 * gathers all of it into one exportable record, with the regression
 * test field made prominent per the build brief, "make it prominent".
 * ------------------------------------------------------------------ */

export interface Postmortem {
  symptomCategory: SymptomCategory | '';
  symptom: string;
  mechanism: string;
  confidence: Confidence;
  evidenceFor: string[];
  evidenceAgainst: string[];
  nextDiagnostic: string;
  containment: ContainmentAction;
  fix: string;
  regressionTest: string;
  incidentNotes: string;
}

/**
 * Builds the postmortem from whichever hypothesis is actually visible
 * and selected. Preferring visibleHypotheses over the raw diagnose()
 * output means the postmortem can never settle on a mechanism with no
 * evidence behind it as long as anything has been answered at all; the
 * only time it falls back to the raw, possibly zero evidence ranking is
 * when nothing has been answered yet, which is the one state honestly
 * described as "not yet determined" below rather than papered over.
 */
export function buildPostmortem(state: InvestigationState): Postmortem {
  const visible = visibleHypotheses(state.answers);
  const pool = visible.length ? visible : diagnose(state.answers);
  const chosenId = state.selectedMechanismId || pool[0]?.mechanismId || '';
  const hypothesis = pool.find((h) => h.mechanismId === chosenId) ?? pool[0];
  const mechanism = getMechanism(hypothesis.mechanismId);

  return {
    symptomCategory: state.symptomCategory,
    symptom: state.description.trim() || '(no description entered)',
    mechanism: visible.length ? hypothesis.name : `${hypothesis.name} (not yet determined, no evidence gathered)`,
    confidence: hypothesis.confidence,
    evidenceFor: hypothesis.evidenceFor,
    evidenceAgainst: hypothesis.evidenceAgainst,
    nextDiagnostic: hypothesis.nextDiagnostic,
    containment: hypothesis.containment,
    fix: mechanism?.durableFix ?? '',
    regressionTest: state.regressionTest.trim() || mechanism?.suggestedRegressionTest || '',
    incidentNotes: state.incidentNotes.trim(),
  };
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * Eleven scenarios. Each one is written so the discriminating answers
 * genuinely point at one mechanism ahead of the rest, verified by
 * tests/tool-failure-investigator.mjs rather than asserted here.
 * Several samples are deliberately built to look alike on the surface,
 * a stale answer, a made up answer, so the questions that actually
 * separate them (toolInvolved, factCheckable) can be seen doing real
 * work instead of only ever discriminating obviously different cases.
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  /** What this sample is meant to teach about telling mechanisms apart. */
  teaches: string;
  symptomCategory: SymptomCategory;
  description: string;
  example: string;
  answers: Answers;
}

export const SAMPLES: Sample[] = [
  {
    id: 'long-session-forgets-rule',
    name: 'Long debugging session drops a rule',
    teaches:
      'Context truncation. The assistant did not hallucinate a new rule, it lost the old one once the conversation grew past its budget.',
    symptomCategory: 'hallucination',
    description:
      'In a long back and forth debugging session, the assistant stopped following a formatting rule we gave it in the second message, after roughly thirty exchanges.',
    example:
      'Assistant reply at exchange 31: returned a plain paragraph instead of the numbered list format requested at the start of the session.',
    answers: {
      reproducible: 'always',
      temperatureZero: 'stillFails',
      inputLength: 'longOnly',
      conversationLength: 'degrades',
      recentChange: 'nothing',
      outputShape: 'plausibleFalse',
      toolInvolved: 'no',
      factCheckable: 'notApplicable',
    },
  },
  {
    id: 'support-bot-old-price',
    name: 'Support bot quotes an old price',
    teaches:
      'Stale index versus retrieval miss. The fact is genuinely findable, just findable in a copy of the world that has not caught up yet.',
    symptomCategory: 'retrieval',
    description:
      'The support bot quoted our old subscription price. The pricing page was updated three weeks ago and nothing about the bot itself was touched.',
    example: 'Bot reply: "Our Pro plan is nineteen dollars per month." The current price has been twenty nine dollars for three weeks.',
    answers: {
      reproducible: 'always',
      temperatureZero: 'stillFails',
      recentChange: 'nothing',
      factCheckable: 'foundButWrong',
      toolInvolved: 'yes',
      untrustedContent: 'no',
      outputShape: 'plausibleFalse',
    },
  },
  {
    id: 'scraper-agent-off-task',
    name: 'Page summarizer starts drafting an email',
    teaches:
      'Prompt injection. The instruction the system followed did not come from the user, it came from inside the page it was told to read.',
    symptomCategory: 'permission',
    description:
      'The agent was asked to summarize a scraped web page and instead started drafting an email to an address mentioned in hidden text on that page.',
    example:
      'Agent output: "Drafting email to legal@example.com as instructed." No such instruction appeared anywhere in the user request.',
    answers: {
      untrustedContent: 'yes',
      outputShape: 'offTask',
      reproducible: 'always',
      recentChange: 'nothing',
      toolInvolved: 'yes',
      temperatureZero: 'stillFails',
    },
  },
  {
    id: 'invoice-json-breaks-long',
    name: 'Invoice extractor breaks only on long invoices',
    teaches:
      'Format drift. Nothing enforces the schema, so free text generation wanders the longer and more complex the answer gets.',
    symptomCategory: 'tool',
    description:
      'Our downstream parser starts failing to read the model output only on the longer, multi page invoices. Short single page invoices parse fine every time.',
    example:
      'Parser error: "Unexpected token at position 812." The output had an unescaped quote inside a line item description on a four page invoice.',
    answers: {
      outputShape: 'malformed',
      inputLength: 'longOnly',
      reproducible: 'sometimes',
      temperatureZero: 'stillFails',
      recentChange: 'nothing',
    },
  },
  {
    id: 'chatbot-repeats-apology',
    name: 'Assistant loops on the same apology',
    teaches:
      'Loop or repetition collapse. The output shape itself, the same sentence over and over, is the whole diagnosis here.',
    symptomCategory: 'loop',
    description:
      'The assistant got stuck repeating the same apology sentence about a dozen times before the response was cut off.',
    example:
      '"I apologize for the confusion. I apologize for the confusion. I apologize for the confusion." repeated eleven more times.',
    answers: {
      outputShape: 'repetitive',
      reproducible: 'sometimes',
      conversationLength: 'degrades',
      recentChange: 'nothing',
    },
  },
  {
    id: 'calendar-tool-silent-timeout',
    name: 'Assistant claims a meeting was booked',
    teaches:
      'Tool error swallowed. The narration is confident and false because the orchestration code never told the model the call actually failed.',
    symptomCategory: 'tool',
    description:
      'The assistant said it had booked the meeting, but the calendar API call actually timed out and nothing was created.',
    example: 'Assistant reply: "Done, I have booked the meeting for 3pm Thursday." No event exists on the calendar for that time.',
    answers: {
      toolInvolved: 'yes',
      outputShape: 'plausibleFalse',
      reproducible: 'sometimes',
      recentChange: 'nothing',
      factCheckable: 'notApplicable',
    },
  },
  {
    id: 'flat-nine-second-replies',
    name: 'Every reply takes the same nine seconds',
    teaches:
      'Serial dependency latency. The wait does not scale with the work, which points at a fixed chain on the critical path rather than the model itself.',
    symptomCategory: 'latency',
    description:
      'Every request takes about nine seconds whether the question is a one line lookup or a complex multi part request.',
    example: 'Request log: nine stages logged sequentially, none overlapping, for both a trivial and a complex request.',
    answers: {
      outputShape: 'slow',
      toolInvolved: 'yes',
      reproducible: 'always',
    },
  },
  {
    id: 'nightly-job-bill-spike',
    name: 'Nightly summarization bill triples',
    teaches:
      'Unbounded output cost. Same volume of work, much higher bill, which points at output length or retries rather than a code defect.',
    symptomCategory: 'cost',
    description:
      'The nightly summarization job bill tripled this month even though the number of documents processed did not change.',
    example: 'Usage log: average output tokens per document rose from 400 to 1300 after a prompt change asked for more detail.',
    answers: {
      outputShape: 'slow',
      recentChange: 'promptChanged',
      reproducible: 'always',
    },
  },
  {
    id: 'fabricated-court-citation',
    name: 'Assistant cites a court case that does not exist',
    teaches:
      'Hallucinated specifics versus retrieval miss. There is no retrieval system in this pipeline at all, so a wrong specific has nowhere to come from except invention.',
    symptomCategory: 'hallucination',
    description:
      'The assistant cited a court case by name and docket number to support its answer. The case does not exist in any legal database.',
    example: 'Assistant reply: "As established in Whitfield v. Marsh Corp, docket 22-4471." No such case exists.',
    answers: {
      outputShape: 'plausibleFalse',
      factCheckable: 'notFound',
      toolInvolved: 'no',
      untrustedContent: 'no',
      reproducible: 'always',
      temperatureZero: 'stillFails',
      recentChange: 'nothing',
    },
  },
  {
    id: 'benign-request-refused',
    name: 'Home security question gets refused',
    teaches:
      'Overbroad refusal. The safety language is matching surface keywords rather than the actual request.',
    symptomCategory: 'permission',
    description:
      'Asked the assistant to explain how door locks work for a home security blog post, and it refused, citing safety.',
    example: 'Assistant reply: "I cannot help with information related to bypassing security systems."',
    answers: {
      outputShape: 'refusal',
      reproducible: 'always',
      recentChange: 'promptChanged',
      temperatureZero: 'stillFails',
    },
  },
  {
    id: 'agent-writes-outside-scope',
    name: 'Read only report turns into a config write',
    teaches:
      'Excess agency. No injected content anywhere, the agent simply held a broader grant than the task needed and used it.',
    symptomCategory: 'permission',
    description:
      'Asked the deployment agent to read the current production config for a report. It also rewrote a feature flag while it was in there, since its service account has write access to the whole config store.',
    example:
      'Agent action log: READ config production full.yaml, then WRITE config production feature flags.yaml, value changed from false to true. The task only asked for a read.',
    answers: {
      outputShape: 'offTask',
      untrustedContent: 'no',
      toolInvolved: 'yes',
      reproducible: 'always',
      recentChange: 'nothing',
    },
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

export interface InvestigationState {
  symptomCategory: SymptomCategory | '';
  description: string;
  example: string;
  answers: Answers;
  selectedMechanismId: string;
  regressionTest: string;
  incidentNotes: string;
}

export function emptyState(): InvestigationState {
  return {
    symptomCategory: '',
    description: '',
    example: '',
    answers: {},
    selectedMechanismId: '',
    regressionTest: '',
    incidentNotes: '',
  };
}

export function sampleState(id: string = SAMPLES[0].id): InvestigationState {
  const sample = getSample(id) ?? SAMPLES[0];
  const top = diagnose(sample.answers)[0];
  return {
    symptomCategory: sample.symptomCategory,
    description: sample.description,
    example: sample.example,
    answers: { ...sample.answers },
    selectedMechanismId: top?.mechanismId ?? '',
    regressionTest: '',
    incidentNotes: '',
  };
}

export function reset(): InvestigationState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: InvestigationState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hasContent = Boolean(state.description.trim() || state.example.trim());

  if (!hasContent) {
    issues.push({
      field: 'description',
      message: 'Describe the bad output, or paste an example, before investigating.',
      severity: 'error',
    });
  }

  if (hasContent && answeredCount(state.answers) === 0) {
    issues.push({
      field: 'answers',
      message: 'No discriminating questions answered yet. Every hypothesis will show as low confidence until you answer at least one.',
      severity: 'warning',
    });
  }

  if (!state.symptomCategory) {
    issues.push({
      field: 'symptomCategory',
      message: 'Pick the incident category that best matches what happened. This orients the catalog and does not gate the diagnosis.',
      severity: 'warning',
    });
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: InvestigationState, format: ExportFormat): string {
  // visibleHypotheses, not diagnose, so the exported ranking matches
  // what the screen shows: only mechanisms with at least one matched
  // cue for or against them, per "No hypothesis is ranked without
  // visible evidence."
  const hypotheses = visibleHypotheses(state.answers);
  const postmortem = buildPostmortem(state);

  const renderContainment = (c: ContainmentAction) =>
    c.destructive
      ? `${c.proposal} DESTRUCTIVE, proposal only, never executed by this tool. Reversibility: ${c.reversibility}`
      : `${c.proposal} Not destructive. Reversibility: ${c.reversibility}`;

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Failure Investigator',
        note:
          'Local heuristic scoring against the answers provided. This is a ranked set of hypotheses, not a proven root cause. Nothing here was transmitted anywhere to produce this report. Every containment step is a proposal for a person to carry out; this tool never executes one.',
        symptomCategory: state.symptomCategory,
        description: state.description,
        example: state.example,
        answers: state.answers,
        hypotheses,
        postmortem,
      },
      null,
      2,
    );
  }

  const renderHypothesis = (h: Hypothesis, index: number) =>
    [
      `${index + 1}. ${h.name} (${MECHANISM_CATEGORY_LABELS[h.category]}), confidence ${h.confidence}, score ${h.score}`,
      `   Evidence for: ${h.evidenceFor.length ? h.evidenceFor.join(' ') : 'none gathered yet.'}`,
      `   Evidence against: ${h.evidenceAgainst.length ? h.evidenceAgainst.join(' ') : 'none gathered yet.'}`,
      `   Next diagnostic: ${h.nextDiagnostic}`,
      `   Containment proposal: ${renderContainment(h.containment)}`,
    ].join('\n');

  return [
    '# Failure Investigator postmortem',
    '',
    'Local heuristic scoring against the answers provided. This is a ranked set of hypotheses, not a proven root cause.',
    '',
    'This tool proposes containment steps and fixes. It never performs them. Every action described below is for a person to carry out and to reverse, if needed, using the reversibility statement attached to it.',
    '',
    `Incident category: ${state.symptomCategory ? SYMPTOM_CATEGORY_LABELS[state.symptomCategory] : 'not set'}`,
    '',
    '## Symptom',
    '',
    state.description || '(no description entered)',
    '',
    '## Example',
    '',
    state.example || '(none pasted)',
    '',
    '## Ranked hypotheses',
    '',
    hypotheses.length
      ? ''
      : 'No discriminating questions answered yet. Nothing is ranked without visible evidence behind it.',
    ...hypotheses.map((h, i) => renderHypothesis(h, i)),
    '',
    '## Selected mechanism',
    '',
    postmortem.mechanism,
    '',
    '## Containment proposal',
    '',
    renderContainment(postmortem.containment),
    '',
    '## Durable fix',
    '',
    postmortem.fix,
    '',
    '## Regression test',
    '',
    postmortem.regressionTest,
    '',
    '## Incident notes',
    '',
    postmortem.incidentNotes || '(none)',
    '',
  ].join('\n');
}

export function filename(_state: InvestigationState, _format: ExportFormat): string {
  return 'failure-investigator-postmortem';
}
