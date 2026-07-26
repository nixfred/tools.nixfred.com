/**
 * Retrieval Laboratory, retrieval engine.
 *
 * PRD: tools-nixfred-prds/tools/04-RAG-LAB.md
 * User outcome: see how chunking, retrieval, and ranking choices change
 * the evidence available to an answer.
 *
 * HARD BOUNDARY FROM THE PRD: "Initial release uses transparent local
 * retrieval. It must not claim semantic equivalence to a production
 * embedding model." This file runs no network call and loads no model.
 * It implements two real, standard lexical algorithms, BM25 and TF-IDF
 * cosine similarity, and one clearly labeled local approximation,
 * character trigram overlap. None of the three understands meaning.
 * The UI states this next to every result, and the honesty text below
 * is what it quotes.
 *
 * The chosen honesty path from the PRD is BOTH acceptable paths at
 * once: lexical retrieval is the primary mode, and one of the shipped
 * sample queries is chosen specifically because lexical retrieval ranks
 * the correct source poorly, which teaches the gap a dense embedding
 * model would close and why. The trigram mode is offered as a second,
 * separately labeled local approximation, never as a substitute for a
 * real embedding model.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

export const CHUNK_STRATEGIES = ['fixed', 'sliding', 'sentence', 'paragraph'] as const;
export type ChunkStrategy = (typeof CHUNK_STRATEGIES)[number];

export const CHUNK_STRATEGY_LABELS: Record<ChunkStrategy, string> = {
  fixed: 'Fixed size',
  sliding: 'Sliding window',
  sentence: 'Sentence',
  paragraph: 'Paragraph',
};

/** Shown next to the strategy selector. Says plainly what each one does
 * and what it costs, so the choice is not a guess. */
export const CHUNK_STRATEGY_HELP: Record<ChunkStrategy, string> = {
  fixed:
    'Splits raw characters into equal, non overlapping blocks. Fast and predictable, and it can cut a sentence, or a word, in half at a boundary.',
  sliding:
    'The same equal size blocks as fixed size, except each new block starts before the previous one ends, so neighboring chunks repeat some text. Costs storage and compute to lower the chance a fact is cut at a boundary.',
  sentence:
    'Packs whole sentences into a chunk until the next sentence would push it over the target size, then starts a new chunk. Never splits a sentence.',
  paragraph:
    'Packs whole paragraphs into a chunk until the next paragraph would push it over the target size. Keeps the most surrounding context, at the cost of coarser retrieval.',
};

export const MIN_CHUNK_SIZE = 20;
export const MAX_CHUNK_SIZE = 2000;
export const MAX_CUSTOM_TEXT_LENGTH = 20000;

export interface ChunkingConfig {
  strategy: ChunkStrategy;
  /** Target size in characters. Strategies that pack whole units treat
   * this as a budget, not a hard cutoff. See CHUNK_STRATEGY_HELP. */
  chunkSize: number;
  /** Characters of repeated text between neighboring chunks, for fixed
   * size and sliding window. For sentence and paragraph, converted to a
   * whole number of trailing units whose combined length is closest to
   * this many characters. */
  overlap: number;
}

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  /** Order within the document, zero based. */
  index: number;
  start: number;
  end: number;
  text: string;
}

interface Unit {
  start: number;
  end: number;
}

/**
 * Sentence units. A sentence is whatever precedes a run of one or more
 * of . ! ? and the whitespace that follows it. Every character of the
 * source text belongs to exactly one unit: the terminator and its
 * trailing whitespace are folded into the sentence they close, and any
 * text left after the final terminator becomes one more unit. This is
 * what lets chunking guarantee full coverage.
 */
function splitSentenceUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const re = /[.!?]+(?:\s+|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length;
    units.push({ start, end });
    start = end;
  }
  if (start < text.length) units.push({ start, end: text.length });
  return units;
}

/**
 * Paragraph units. A paragraph is whatever precedes a run of two or
 * more newlines, with that blank line folded into the paragraph it
 * closes, mirroring splitSentenceUnits so the same total coverage
 * guarantee holds.
 */
function splitParagraphUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const re = /\n{2,}/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length;
    units.push({ start, end });
    start = end;
  }
  if (start < text.length) units.push({ start, end: text.length });
  return units;
}

/**
 * Pack a list of units, which already partition the source text with no
 * gaps, into chunks bounded by chunkSize, repeating overlapChars worth
 * of trailing units at the start of the next chunk.
 *
 * PROOF OF COVERAGE, the property tests/tool-rag-lab.mjs checks by
 * slicing rather than trusting: every chunk this produces starts at
 * unit i and ends at unit j - 1, and the next chunk starts at
 * nextStart, where nextStart <= j always, because nextStart is either
 * j itself (no overlap) or max(i + 1, k + 1) with k < j (overlap). A
 * value at or before j never leaves a gap after a range ending at
 * j - 1, and nextStart > i guarantees the loop always makes progress.
 * By induction over the whole unit list, which itself has no gaps, the
 * produced chunks cover every character of the source text.
 */
function packUnits(units: Unit[], chunkSize: number, overlapChars: number): Unit[] {
  const packed: Unit[] = [];
  const overlap = Math.max(0, overlapChars);
  let i = 0;
  while (i < units.length) {
    let j = i;
    let length = 0;
    // Always take at least one unit, even if it alone exceeds the
    // budget, so a single long sentence still becomes a chunk rather
    // than vanishing.
    while (j < units.length) {
      const unitLength = units[j].end - units[j].start;
      if (j > i && length + unitLength > chunkSize) break;
      length += unitLength;
      j++;
    }
    packed.push({ start: units[i].start, end: units[j - 1].end });
    if (j >= units.length) break;

    let overlapLength = 0;
    let k = j - 1;
    while (k >= i && overlap > 0 && overlapLength < overlap) {
      overlapLength += units[k].end - units[k].start;
      k--;
    }
    i = overlap > 0 ? Math.max(i + 1, k + 1) : j;
  }
  return packed;
}

/** Non overlapping character windows. Step equals size, so the
 * overlap knob does not apply to this strategy, which is the whole
 * point of shipping sliding window as a separate choice. */
function chunkFixed(text: string, size: number): Unit[] {
  const n = Math.max(1, size);
  const units: Unit[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + n, text.length);
    units.push({ start, end });
    start = end;
  }
  return units;
}

/** Overlapping character windows. Step is size minus overlap, clamped
 * to at least one character so the loop always advances. */
function chunkSliding(text: string, size: number, overlap: number): Unit[] {
  const n = Math.max(1, size);
  const step = Math.max(1, n - Math.max(0, overlap));
  const units: Unit[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + n, text.length);
    units.push({ start, end });
    if (end >= text.length) break;
    start += step;
  }
  return units;
}

export function chunkDocument(doc: SourceDocument, config: ChunkingConfig): Chunk[] {
  const text = doc.text;
  if (!text) return [];

  let units: Unit[];
  switch (config.strategy) {
    case 'fixed':
      units = chunkFixed(text, config.chunkSize);
      break;
    case 'sliding':
      units = chunkSliding(text, config.chunkSize, config.overlap);
      break;
    case 'sentence':
      units = packUnits(splitSentenceUnits(text), config.chunkSize, config.overlap);
      break;
    case 'paragraph':
      units = packUnits(splitParagraphUnits(text), config.chunkSize, config.overlap);
      break;
  }

  return units.map((u, index) => ({
    id: `${doc.id}:${index}`,
    docId: doc.id,
    docTitle: doc.title,
    index,
    start: u.start,
    end: u.end,
    text: text.slice(u.start, u.end),
  }));
}

export function chunkCorpus(docs: SourceDocument[], config: ChunkingConfig): Chunk[] {
  return docs.flatMap((doc) => chunkDocument(doc, config));
}

/* ------------------------------------------------------------------ *
 * Tokenization, shared by both real lexical ranking methods.
 * ------------------------------------------------------------------ */

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

export const RANK_METHODS = ['bm25', 'tfidf', 'ngram'] as const;
export type RankMethod = (typeof RANK_METHODS)[number];

export const RANK_METHOD_LABELS: Record<RankMethod, string> = {
  bm25: 'BM25 (lexical)',
  tfidf: 'TF-IDF cosine (lexical)',
  ngram: 'Trigram overlap (local approximation)',
};

/**
 * The honesty statement the UI renders next to whichever method is
 * selected. BM25 and TF-IDF are real, standard, fully local algorithms,
 * not a simulation of one. Trigram overlap is labeled unambiguously as
 * an approximation and not a model.
 */
export const RANK_METHOD_HONESTY: Record<RankMethod, string> = {
  bm25: 'A real, standard lexical ranking function. It scores exact word matches, weighted by how rare each word is across the current chunk set. It has no notion of meaning: refund and reimbursement share no letters, so it cannot tell they mean the same thing.',
  tfidf: 'A real, standard lexical ranking function built from term frequency, inverse document frequency, and cosine similarity. Like BM25, it matches words, not meaning.',
  ngram: 'A local approximation, not a real embedding model. It measures shared three character sequences between the query and a chunk, which can catch spelling variants and shared word stems but still has no notion of meaning. A true dense embedding model, which this tool cannot run locally without a network call, would likely recognize a paraphrase that shares no words or letters at all, and none of the three methods here can do that.',
};

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  matchedTerms: string[];
  /** Plain language reason the UI shows next to the score, the PRD
   * requirement that "the UI exposes why a chunk ranked". */
  reason: string;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * BM25 over the current chunk set. Statistics, document count, average
 * length, and document frequency, are recomputed from the chunks
 * passed in, because a different chunking configuration produces a
 * different collection to rank against.
 *
 * WORKED EXAMPLE, verified by hand in
 * tests/tool-rag-lab.mjs: two one term chunks, "cat cat" and "dog",
 * scored against the query "cat", with k1 = 1.5 and b = 0.75.
 */
export function bm25Score(query: string, chunks: Chunk[]): ScoredChunk[] {
  const docs = chunks.map((c) => {
    const tokens = tokenize(c.text);
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    return { length: tokens.length, termFreq };
  });

  const n = docs.length;
  const avgdl = n === 0 ? 0 : docs.reduce((sum, d) => sum + d.length, 0) / n;
  const docFreq = new Map<string, number>();
  for (const d of docs) {
    for (const term of d.termFreq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  const queryTerms = Array.from(new Set(tokenize(query)));

  return chunks
    .map((chunk, i) => {
      const d = docs[i];
      let score = 0;
      const matched: string[] = [];
      for (const term of queryTerms) {
        const docsWithTerm = docFreq.get(term) ?? 0;
        const f = d.termFreq.get(term) ?? 0;
        if (docsWithTerm === 0 || f === 0) continue;
        const idf = Math.log((n - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1);
        const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / (avgdl || 1));
        score += idf * ((f * (BM25_K1 + 1)) / denom);
        matched.push(term);
      }
      return {
        chunk,
        score,
        matchedTerms: matched,
        reason: describeMatch(matched, queryTerms, 'BM25'),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * TF-IDF with smoothed IDF, ln((1 + N) / (1 + docFreq)) + 1, the same
 * smoothing scikit-learn uses by default, so a term in every chunk
 * still gets a small positive weight instead of zero. Vectors are L2
 * normalized before the dot product, which is what makes the result a
 * cosine similarity.
 */
export function tfidfScore(query: string, chunks: Chunk[]): ScoredChunk[] {
  const docTokens = chunks.map((c) => tokenize(c.text));
  const n = docTokens.length;
  const docFreq = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const idf = (term: string) => Math.log((1 + n) / (1 + (docFreq.get(term) ?? 0))) + 1;

  const vectorize = (tokens: string[]) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [t, f] of tf) vec.set(t, f * idf(t));
    return vec;
  };
  const norm = (vec: Map<string, number>) =>
    Math.sqrt(Array.from(vec.values()).reduce((sum, v) => sum + v * v, 0));

  const queryTokens = tokenize(query);
  const queryVec = vectorize(queryTokens);
  const queryNorm = norm(queryVec) || 1;
  const uniqueQueryTerms = Array.from(new Set(queryTokens));

  return chunks
    .map((chunk, i) => {
      const docVec = vectorize(docTokens[i]);
      const docNorm = norm(docVec) || 1;
      let dot = 0;
      const matched: string[] = [];
      for (const [term, weight] of queryVec) {
        const docWeight = docVec.get(term);
        if (docWeight) {
          dot += weight * docWeight;
          matched.push(term);
        }
      }
      return {
        chunk,
        score: dot / (queryNorm * docNorm),
        matchedTerms: matched,
        reason: describeMatch(matched, uniqueQueryTerms, 'TF-IDF cosine'),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function describeMatch(matched: string[], queryTerms: string[], methodLabel: string): string {
  if (queryTerms.length === 0) return 'The query has no words to match.';
  if (matched.length === 0) {
    return `Matched none of the ${queryTerms.length} query terms under ${methodLabel}.`;
  }
  return `Matched ${matched.length} of ${queryTerms.length} query terms under ${methodLabel}: ${matched.join(', ')}.`;
}

const NGRAM_SIZE = 3;

function charTrigrams(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (cleaned.length < NGRAM_SIZE) return cleaned ? new Set([cleaned]) : new Set();
  const grams = new Set<string>();
  for (let i = 0; i <= cleaned.length - NGRAM_SIZE; i++) {
    grams.add(cleaned.slice(i, i + NGRAM_SIZE));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Trigram overlap. Explicitly the second honesty path from the PRD: a
 * deterministic local approximation, built from shared character
 * sequences, labeled as exactly that everywhere it appears in the UI.
 * It is not a neural embedding and RANK_METHOD_HONESTY.ngram says so.
 */
export function ngramScore(query: string, chunks: Chunk[]): ScoredChunk[] {
  const queryGrams = charTrigrams(query);
  return chunks
    .map((chunk) => {
      const score = jaccard(queryGrams, charTrigrams(chunk.text));
      return {
        chunk,
        score,
        matchedTerms: [],
        reason: `Trigram overlap ${score.toFixed(3)}. Local approximation, not a real embedding.`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function rankChunks(method: RankMethod, query: string, chunks: Chunk[]): ScoredChunk[] {
  if (!query.trim() || chunks.length === 0) {
    return chunks.map((chunk) => ({
      chunk,
      score: 0,
      matchedTerms: [],
      reason: 'No query entered yet.',
    }));
  }
  if (method === 'bm25') return bm25Score(query, chunks);
  if (method === 'tfidf') return tfidfScore(query, chunks);
  return ngramScore(query, chunks);
}

/* ------------------------------------------------------------------ *
 * Maximal marginal relevance, an optional diversity re-rank.
 * ------------------------------------------------------------------ */

/**
 * Re-rank the pool by relevance minus redundancy against what has
 * already been selected. Redundancy is measured with the same trigram
 * Jaccard similarity used by the ngram ranking method: it is a real,
 * local, cheap similarity between two pieces of text, so reusing it
 * here avoids inventing a second unverified notion of "alike".
 *
 * lambda = 1 ignores diversity and reproduces the plain ranked order.
 * lambda = 0 ignores relevance and only avoids repeating a chunk that
 * resembles one already picked.
 */
export function mmrRerank(ranked: ScoredChunk[], k: number, lambda: number): ScoredChunk[] {
  if (ranked.length === 0 || k <= 0) return [];
  const pool = [...ranked];
  const selected: ScoredChunk[] = [];
  const maxScore = Math.max(...pool.map((p) => p.score), 1e-9);
  const grams = new Map<string, Set<string>>();
  const gramsFor = (chunk: Chunk) => {
    let g = grams.get(chunk.id);
    if (!g) {
      g = charTrigrams(chunk.text);
      grams.set(chunk.id, g);
    }
    return g;
  };

  while (selected.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const relevance = pool[i].score / maxScore;
      const maxSimilarity =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((s) => jaccard(gramsFor(s.chunk), gramsFor(pool[i].chunk))));
      const value = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    selected.push(pool[bestIndex]);
    pool.splice(bestIndex, 1);
  }
  return selected;
}

/* ------------------------------------------------------------------ *
 * Retrieval, the pipeline a single configuration runs end to end.
 * ------------------------------------------------------------------ */

export interface RetrievalConfig {
  chunking: ChunkingConfig;
  rankMethod: RankMethod;
  topK: number;
  scoreThreshold: number;
  useMmr: boolean;
  mmrLambda: number;
}

export interface MissedEvidence {
  scored: ScoredChunk;
  reason: string;
}

export interface RetrievalResult {
  /** Every chunk the configuration produced, in document order. This is
   * the PRD requirement to "show the actual chunks produced from the
   * corpus", independent of ranking. */
  chunks: Chunk[];
  /** Every chunk, scored and sorted, before top k or the threshold cut. */
  ranked: ScoredChunk[];
  /** What the user actually receives. */
  selected: ScoredChunk[];
  /** Notable chunks that scored but were not selected, and why. */
  missed: MissedEvidence[];
  /** A grounded answer scaffold, not a generated answer. It cites the
   * selected chunks and instructs whoever, or whatever, answers next to
   * stay inside them. */
  answerTemplate: string;
}

function excerpt(text: string, max = 160): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function buildAnswerTemplate(query: string, selected: ScoredChunk[]): string {
  if (!query.trim()) return 'Enter a query to generate a grounded answer template.';
  if (selected.length === 0) {
    return `No chunk cleared the current settings for "${query}". Lower the score threshold, raise top k, or try a different ranking method.`;
  }
  const citations = selected
    .map(
      (s, i) =>
        `${i + 1}. ${s.chunk.docTitle}, chunk ${s.chunk.index + 1}: "${excerpt(s.chunk.text)}"`,
    )
    .join('\n');
  return [
    `Answer "${query}" using only the numbered evidence below. Cite the matching number for every claim, and say plainly when the evidence does not cover part of the question.`,
    '',
    citations,
  ].join('\n');
}

export function runRetrieval(
  docs: SourceDocument[],
  query: string,
  config: RetrievalConfig,
): RetrievalResult {
  const chunks = chunkCorpus(docs, config.chunking);
  const ranked = rankChunks(config.rankMethod, query, chunks);
  const aboveThreshold = ranked.filter((r) => r.score > config.scoreThreshold);

  const selected = config.useMmr
    ? mmrRerank(aboveThreshold, config.topK, config.mmrLambda)
    : aboveThreshold.slice(0, Math.max(0, config.topK));

  const selectedIds = new Set(selected.map((s) => s.chunk.id));
  const missed: MissedEvidence[] = ranked
    .filter((r) => !selectedIds.has(r.chunk.id))
    .slice(0, 5)
    .map((r) => ({
      scored: r,
      reason:
        r.score <= config.scoreThreshold
          ? `Scored ${r.score.toFixed(3)}, at or below the threshold of ${config.scoreThreshold}.`
          : `Scored ${r.score.toFixed(3)}, ranked outside the top ${config.topK}.`,
    }));

  return {
    chunks,
    ranked,
    selected,
    missed,
    answerTemplate: buildAnswerTemplate(query, selected),
  };
}

/* ------------------------------------------------------------------ *
 * Sample corpus.
 *
 * Five short documents, a few hundred words each, drawn from one
 * fictional platform's internal operations so the vocabulary overlaps
 * the way a real knowledge base's does. One document, the billing
 * procedure, is written to describe a refund without ever using the
 * word refund, on purpose: see SAMPLE_QUERIES below.
 * ------------------------------------------------------------------ */

export interface SourceDocument {
  id: string;
  title: string;
  text: string;
}

export const CORPUS: SourceDocument[] = [
  {
    id: 'deploy-runbook',
    title: 'Deployment Runbook',
    text: 'Deployments to production follow a staged rollout. Engineers open a deployment ticket describing the change, the rollback plan, and the Customer facing risk. A canary release ships to five percent of traffic for thirty minutes while the on call engineer watches error rate, latency, and the crash dashboard. If every signal stays inside its normal band, the rollout advances to fifty percent, then to full traffic, each stage separated by a fifteen minute hold. Any signal that crosses its alert threshold during a hold triggers an automatic rollback to the last known good release. A manual rollback is also available at any time through the deploy console, and it restores the previous release within two minutes. Every deployment, whether it completes or rolls back, produces a summary that lists the commit range, the stages reached, and any alerts that fired. Database migrations that cannot be reversed require a separate review before the ticket is approved, because a rollback of the application code does not undo a schema change. Cloud provider invoices are final. We do not refund unused compute credits after a deployment window closes, so capacity should be provisioned conservatively rather than assuming a later adjustment. Deployment windows are Monday through Thursday, and no deployment ships within four hours of a holiday.',
  },
  {
    id: 'incident-response',
    title: 'Incident Response Guide',
    text: 'Incidents are classified into four severities. Severity one is a full outage or a Customer facing data loss risk, and it pages the on call engineer immediately with a fifteen minute acknowledgement target. Severity two is a significant degradation limited to one region or one feature, with a thirty minute acknowledgement target. Severity three and four cover minor and cosmetic issues that are triaged during business hours. The on call rotation is weekly, and the engineer carries a pager plus a secondary contact who is paged if the primary does not acknowledge within the target window. Every severity one and severity two incident gets a live channel, a designated incident commander, and a running timeline of actions taken. The incident commander decides when to declare the incident resolved and when to start the postmortem. Postmortems are blameless and due within five business days of resolution. They record the detection time, the time to mitigation, the root cause, and at least one action item with an owner and a date. Repeated incidents with the same root cause are escalated to the reliability review board, which can require a design change before further feature work resumes on the affected system.',
  },
  {
    id: 'billing-adjustments',
    title: 'Billing Adjustment Procedure',
    text: 'When a Customer is charged in error, the billing team issues a corrected invoice rather than editing the original record, so the audit trail stays intact. Duplicate charges, the most common case, are identified by matching the payment processor transaction id against our own charge log, and any match with the same amount within a ten minute window is treated as a duplicate. Once confirmed, the excess amount is credited back to the original payment method within three business days, and the Customer receives an email with the corrected invoice attached. If the original payment method has expired or been closed, the credit is issued instead as account balance that applies automatically to the Customer next invoice. Chargebacks are handled separately from ordinary corrections. A chargeback filed with the card network freezes the disputed amount and opens a case with our payments partner, and the billing team responds with the original invoice, the usage records, and any prior correspondence with the Customer. Cases that involve a suspected pattern of abuse are escalated to the risk team before any credit is issued. All adjustments over five hundred dollars require a second approver regardless of the reason, and every adjustment is logged with the approver, the amount, and the reason code.',
  },
  {
    id: 'rate-limiting-policy',
    title: 'API Rate Limiting Policy',
    text: 'Every API key is subject to a rate limit measured in requests per minute, with a default of six hundred and a burst allowance of one hundred additional requests for up to ten seconds. Limits are enforced per key, not per account, so a Customer running several keys for different services is not penalized for the traffic of an unrelated key. A request that exceeds the limit receives a standard too many requests response with a retry after header stating the number of seconds until the window resets. Sustained excess traffic, defined as ten consecutive rate limited minutes, triggers a temporary key suspension of five minutes to protect shared infrastructure, and the suspension is logged and visible in the Customer dashboard. Enterprise plans can request a higher default limit through account management, subject to a capacity review by the platform team. The review checks whether the requested rate is consistent with the Customer historical usage and whether current infrastructure headroom supports it without affecting other tenants. Limits are never raised silently. Any change is confirmed in writing and takes effect within one business day. Internal service accounts used for platform maintenance are exempt from these limits but are monitored separately for abuse.',
  },
  {
    id: 'data-retention-policy',
    title: 'Data Retention and Backup Policy',
    text: 'Backups run nightly for every production database and are stored in a separate region from the primary. Nightly backups are retained for 35 days before permanent deletion, and a monthly snapshot taken on the first of each month is retained for one year. Backups are encrypted at rest using AES-256 and in transit using TLS 1.2 or later, and the encryption keys are rotated quarterly by the security team. A restore request can target any retained backup and typically completes within four hours for a single database, though a full environment restore can take a full business day. Deleted Customer accounts follow a separate schedule. Account data is retained for 30 days after deletion to allow for accidental deletion recovery, then permanently purged from both the primary store and all retained backups, including ones created before the deletion request. Logs containing request metadata are retained for 90 days for debugging and abuse investigation, then deleted automatically. Any legal hold on an account suspends its deletion schedule until the hold is lifted, and holds are tracked in a separate register reviewed monthly by the compliance team.',
  },
];

export interface SampleQuery {
  id: string;
  query: string;
  /** What this query is chosen to demonstrate. Shown in the UI. */
  teaches: string;
  /** The document the correct answer actually lives in. */
  expectedDocId: string;
  /** True for the query documented to defeat lexical retrieval. */
  lexicalFailure: boolean;
  /** Longer explanation shown when the query is loaded. */
  explanation: string;
}

export const SAMPLE_QUERIES: SampleQuery[] = [
  {
    id: 'rollback-steps',
    query: 'What are the steps to roll back a failed deployment?',
    teaches:
      'A well matched query. The words in the question, rollback and deployment, appear directly in the correct source, so lexical retrieval finds it easily.',
    expectedDocId: 'deploy-runbook',
    lexicalFailure: false,
    explanation:
      'This is the easy case, included on purpose as a baseline. Both BM25 and TF-IDF should rank the deployment runbook chunk first, because the query shares exact words with the source. Use it to confirm the pipeline behaves sensibly before trusting the harder queries below.',
  },
  {
    id: 'refund-paraphrase',
    query: 'What is our refund process for a Customer?',
    teaches:
      'The lexical failure case. The billing procedure describes exactly this situation, credited back, corrected invoice, chargeback, but never uses the word refund.',
    expectedDocId: 'billing-adjustments',
    lexicalFailure: true,
    explanation:
      'BM25 and TF-IDF both score chunks by shared words, weighted by how rare each word is. The word refund is rare in this corpus, it appears exactly once, in the deployment runbook, in an unrelated sentence about compute credits. That single match can out rank the billing procedure chunk, which is the actually correct source but shares no rare words with the query. A dense embedding model would likely recognize that credited back and refund describe the same action and would not make this mistake. Run this query under BM25 or TF-IDF and check the rank of each source chunk to see the failure directly rather than take this description on faith.',
  },
  {
    id: 'retention-and-encryption',
    query: 'How many days are backups retained before deletion, and how are they encrypted?',
    teaches:
      'A chunk size lesson rather than a ranking failure. The retention duration and the encryption method sit in adjacent sentences of one paragraph, so a small chunk size can split them into two chunks, and neither one alone answers the full question.',
    expectedDocId: 'data-retention-policy',
    lexicalFailure: false,
    explanation:
      'Compare a small sentence sized chunk against a paragraph sized chunk on this query. With a small chunk size, one retrieved chunk carries the 35 day retention figure and a different chunk carries the AES-256 and TLS detail, so the answer template cites two partial chunks instead of one complete one. Paragraph chunking, or a larger chunk size, keeps both facts in the same chunk. Neither behavior is a bug: it is what the chunk size choice actually does to the evidence available to an answer.',
  },
];

export function getSampleQuery(id: string): SampleQuery | undefined {
  return SAMPLE_QUERIES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

function defaultConfigA(): RetrievalConfig {
  return {
    chunking: { strategy: 'sentence', chunkSize: 150, overlap: 0 },
    rankMethod: 'bm25',
    topK: 3,
    scoreThreshold: 0,
    useMmr: false,
    mmrLambda: 0.5,
  };
}

function defaultConfigB(): RetrievalConfig {
  return {
    chunking: { strategy: 'paragraph', chunkSize: 600, overlap: 0 },
    rankMethod: 'bm25',
    topK: 3,
    scoreThreshold: 0,
    useMmr: false,
    mmrLambda: 0.5,
  };
}

export type CorpusSource = 'sample' | 'custom';

export interface RagLabState {
  corpusSource: CorpusSource;
  /** Pasted text, treated as one document when corpusSource is custom.
   * "Pasted data remains local", the PRD acceptance criterion: nothing
   * in this file, or anywhere in the tool, sends this anywhere. */
  customText: string;
  query: string;
  sampleQueryId: string;
  configA: RetrievalConfig;
  configB: RetrievalConfig;
}

export function emptyState(): RagLabState {
  return {
    corpusSource: 'sample',
    customText: '',
    query: '',
    sampleQueryId: SAMPLE_QUERIES[0].id,
    configA: defaultConfigA(),
    configB: defaultConfigB(),
  };
}

export function sampleState(id: string = SAMPLE_QUERIES[0].id): RagLabState {
  const sample = getSampleQuery(id) ?? SAMPLE_QUERIES[0];
  return {
    corpusSource: 'sample',
    customText: '',
    query: sample.query,
    sampleQueryId: sample.id,
    configA: defaultConfigA(),
    configB: defaultConfigB(),
  };
}

export function reset(): RagLabState {
  return emptyState();
}

/** Resolve the current corpus from state. Custom text is capped so a
 * very large paste cannot make every keystroke slow. */
export function getCorpus(state: RagLabState): SourceDocument[] {
  if (state.corpusSource === 'custom') {
    const text = state.customText.slice(0, MAX_CUSTOM_TEXT_LENGTH);
    return text.trim() ? [{ id: 'pasted', title: 'Pasted text', text }] : [];
  }
  return CORPUS;
}

export function runForState(state: RagLabState, which: 'a' | 'b'): RetrievalResult {
  const docs = getCorpus(state);
  const config = which === 'a' ? state.configA : state.configB;
  return runRetrieval(docs, state.query, config);
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: RagLabState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!state.query.trim()) {
    issues.push({
      field: 'query',
      message: 'Enter a query, or load a sample query, to run retrieval.',
      severity: 'error',
    });
  }

  if (state.corpusSource === 'custom' && !state.customText.trim()) {
    issues.push({
      field: 'customText',
      message: 'Paste some text, or switch back to the sample corpus.',
      severity: 'warning',
    });
  }

  for (const [label, config] of [
    ['configA', state.configA],
    ['configB', state.configB],
  ] as const) {
    if (config.chunking.chunkSize < MIN_CHUNK_SIZE) {
      issues.push({
        field: `${label}.chunkSize`,
        message: `Chunk size below ${MIN_CHUNK_SIZE} characters produces chunks too small to retrieve anything meaningful.`,
        severity: 'warning',
      });
    }
    if (config.topK < 1) {
      issues.push({
        field: `${label}.topK`,
        message: 'Top k must be at least 1.',
        severity: 'error',
      });
    }
  }

  return issues;
}
