/**
 * Retrieval Laboratory, logic gate.
 *
 * Run: bun tests/tool-rag-lab.mjs
 *
 * Proves the PRD acceptance criteria that are properties of the engine
 * rather than of the page:
 *   1. Chunking, every strategy, covers the entire source text with no
 *      lost characters, verified by walking the actual chunk offsets
 *      rather than trusting the implementation.
 *   2. Overlap behaves exactly as specified, per strategy.
 *   3. BM25 is correct against a hand computed case.
 *   4. Ranking is deterministic.
 *   5. Changing chunk size changes the retrieved set.
 *   6. The documented lexical failure query genuinely ranks the correct
 *      source poorly, and the documented well matched query genuinely
 *      does not, proving both are real properties of the engine rather
 *      than asserted in a comment somewhere.
 *
 * A gate that only checked "results.length > 0" would pass on an engine
 * that silently dropped half the corpus, and coverage is the whole
 * point of criterion 1, so every chunking check below reconstructs
 * coverage by slicing offsets.
 */

import {
  CHUNK_STRATEGIES,
  CORPUS,
  SAMPLE_QUERIES,
  MAX_CUSTOM_TEXT_LENGTH,
  chunkDocument,
  chunkCorpus,
  bm25Score,
  tfidfScore,
  ngramScore,
  rankChunks,
  mmrRerank,
  runRetrieval,
  runForState,
  emptyState,
  sampleState,
  reset,
  validate,
  getCorpus,
} from '../src/lib/tools/rag-lab.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('rag-lab logic gate');

/* ---- 1. Sample corpus and sample queries shape ------------------- */
expect('samples', SAMPLE_QUERIES.length >= 3, `only ${SAMPLE_QUERIES.length} sample queries, PRD requires at least three`);
expect('corpus', CORPUS.length >= 2, 'a corpus of one document cannot demonstrate cross document ranking failures');
for (const doc of CORPUS) {
  expect('corpus shape', Boolean(doc.id && doc.title && doc.text.trim()), `document ${doc.id || '(no id)'} is missing a field`);
  expect('corpus length', doc.text.split(/\s+/).length >= 80, `document ${doc.id} is under 80 words, PRD wants a few hundred per document`);
}
const corpusIds = new Set(CORPUS.map((d) => d.id));
for (const sq of SAMPLE_QUERIES) {
  expect('sample query shape', Boolean(sq.id && sq.query.trim() && sq.teaches && sq.explanation), `sample query ${sq.id || '(no id)'} is missing a field`);
  expect('sample query target', corpusIds.has(sq.expectedDocId), `sample query ${sq.id} names an unknown expectedDocId "${sq.expectedDocId}"`);
}
expect('lexical failure present', SAMPLE_QUERIES.some((s) => s.lexicalFailure), 'no sample query is marked as the documented lexical failure case');
console.log(`  corpus: ${CORPUS.length} documents, sample queries: ${SAMPLE_QUERIES.length}`);

/* ---- 2. Chunking coverage, every strategy, no lost characters ----- */
/**
 * Reconstructs coverage from raw offsets: sorts chunks by start, then
 * walks them checking that each one starts at or before the character
 * the previous one reached, so there is never a gap, and that the last
 * one reaches the end of the source text. This is the direct proof of
 * "every strategy covers the entire corpus with no lost characters",
 * checked against the offsets the chunker actually returned rather than
 * assumed from the algorithm description.
 */
function assertFullCoverage(label, sourceLength, chunks) {
  if (sourceLength === 0) {
    expect(label, chunks.length === 0, 'an empty document produced chunks');
    return;
  }
  expect(label, chunks.length > 0, 'a non empty document produced no chunks');
  const sorted = [...chunks].sort((a, b) => a.start - b.start);
  let reached = 0;
  for (const c of sorted) {
    expect(label, c.start <= reached, `gap before character ${c.start}, coverage had only reached ${reached}`);
    expect(label, c.end > c.start, 'a chunk has zero or negative length');
    reached = Math.max(reached, c.end);
  }
  expect(label, reached === sourceLength, `coverage reached ${reached}, source is ${sourceLength} characters`);
}

const chunkSizeMatrix = [40, 150, 600];
let coverageChecked = 0;
for (const doc of CORPUS) {
  for (const strategy of CHUNK_STRATEGIES) {
    for (const chunkSize of chunkSizeMatrix) {
      for (const overlap of [0, Math.floor(chunkSize / 4)]) {
        const chunks = chunkDocument(doc, { strategy, chunkSize, overlap });
        assertFullCoverage(`coverage ${strategy}`, doc.text.length, chunks);
        // Every chunk's text must be the exact slice its own offsets
        // name, so a chunk can always be traced back to its source,
        // the PRD acceptance criterion "every selected passage can be
        // traced to its source".
        for (const c of chunks) {
          expect('chunk traceable to source', doc.text.slice(c.start, c.end) === c.text, `${strategy} chunk ${c.id} text does not match doc.text.slice(${c.start}, ${c.end})`);
        }
        coverageChecked += 1;
      }
    }
  }
}
console.log(`  chunking coverage verified: ${coverageChecked} (strategy x document x size x overlap combinations)`);

/* ---- 3. Overlap behaves exactly as specified ---------------------- */

// Fixed size: the overlap knob does not apply. Step equals chunk size,
// so adjacent chunks touch and never repeat a character.
{
  const doc = { id: 'x', title: 'x', text: 'a'.repeat(500) };
  const withOverlapRequested = chunkDocument(doc, { strategy: 'fixed', chunkSize: 100, overlap: 40 });
  for (let i = 1; i < withOverlapRequested.length; i++) {
    expect('fixed ignores overlap', withOverlapRequested[i].start === withOverlapRequested[i - 1].end, `fixed size chunk ${i} starts at ${withOverlapRequested[i].start}, expected exactly ${withOverlapRequested[i - 1].end}`);
  }
  expect('fixed chunk count', withOverlapRequested.length === 5, `500 characters at size 100 should make 5 chunks, got ${withOverlapRequested.length}`);
}

// Sliding window: adjacent chunks repeat exactly `overlap` characters,
// except the final chunk, which is only as long as the text left.
{
  const doc = { id: 'x', title: 'x', text: 'b'.repeat(537) };
  const size = 100;
  const overlap = 30;
  const chunks = chunkDocument(doc, { strategy: 'sliding', chunkSize: size, overlap });
  for (let i = 1; i < chunks.length - 1; i++) {
    const actualOverlap = chunks[i - 1].end - chunks[i].start;
    expect('sliding overlap exact', actualOverlap === overlap, `chunk ${i} overlaps its predecessor by ${actualOverlap} characters, expected ${overlap}`);
    expect('sliding size exact', chunks[i].end - chunks[i].start === size, `chunk ${i} is ${chunks[i].end - chunks[i].start} characters, expected ${size}`);
  }
  console.log(`  sliding window: ${chunks.length} chunks over ${doc.text.length} characters, overlap held at ${overlap} for every interior chunk`);
}

// Sentence and paragraph: overlap 0 means the chunks are disjoint and
// concatenate back to the exact original text. Overlap greater than 0
// means the last sentence, or paragraph, of a chunk reappears as the
// start of the next one.
{
  // Six short, uniform sentences, built specifically so a chunk size of
  // 50 packs two of them together, leaving room for overlap to repeat
  // exactly one trailing sentence. Real corpus sentences vary too much
  // in length to guarantee that shape, which is why this check uses a
  // synthetic document instead.
  const doc = {
    id: 'synthetic',
    title: 'synthetic',
    text: 'Sentence one is here. Sentence two is here. Sentence three is here. Sentence four is here. Sentence five is here. Sentence six is here.',
  };

  const noOverlap = chunkDocument(doc, { strategy: 'sentence', chunkSize: 50, overlap: 0 });
  expect('sentence overlap zero packs multiple units', noOverlap.some((c) => (c.text.match(/Sentence/g) ?? []).length > 1), 'test setup assumption broke: chunk size 50 was expected to pack more than one sentence per chunk');
  const rebuilt = noOverlap.map((c) => c.text).join('');
  expect('sentence overlap zero is disjoint', rebuilt === doc.text, 'concatenating chunks with overlap 0 did not reconstruct the source exactly');

  const withOverlap = chunkDocument(doc, { strategy: 'sentence', chunkSize: 50, overlap: 20 });
  let repeats = 0;
  for (let i = 1; i < withOverlap.length; i++) {
    if (withOverlap[i].start < withOverlap[i - 1].end) repeats += 1;
  }
  expect('sentence overlap repeats content', repeats > 0, 'requesting overlap 20 produced no repeated sentence between any pair of chunks');
  expect('sentence overlap still covers the source', withOverlap[withOverlap.length - 1].end === doc.text.length, 'overlapping sentence chunks failed to reach the end of the source');
  console.log(`  sentence chunking: overlap 0 gives ${noOverlap.length} disjoint chunks reconstructing the source exactly, overlap 20 repeats content across ${repeats} of ${withOverlap.length - 1} boundaries`);

  const paraDoc = CORPUS.find((d) => d.id === 'incident-response');
  const paraNoOverlap = chunkDocument(paraDoc, { strategy: 'paragraph', chunkSize: 2000, overlap: 0 });
  expect('paragraph overlap zero is disjoint', paraNoOverlap.map((c) => c.text).join('') === paraDoc.text, 'paragraph chunking with overlap 0 did not reconstruct the source exactly');
}

/* ---- 4. BM25 correctness against a hand computed case ------------- */
/**
 * Two single term chunks: "cat cat" (two tokens, both cat) and "dog"
 * (one token). Query "cat". k1 = 1.5, b = 0.75 (BM25_K1, BM25_B in the
 * module, not exported because they are not meant to be tuned from
 * outside, restated here for the arithmetic).
 *
 * N = 2 chunks. avgdl = (2 + 1) / 2 = 1.5.
 * "cat" appears in 1 of 2 chunks, so docsWithTerm = 1.
 * idf = ln((N - n + 0.5) / (n + 0.5) + 1)
 *     = ln((2 - 1 + 0.5) / (1 + 0.5) + 1)
 *     = ln(1.5 / 1.5 + 1) = ln(2) = 0.6931471805599453.
 *
 * Chunk "cat cat": f = 2, docLength = 2.
 * denom = f + k1 * (1 - b + b * docLength / avgdl)
 *       = 2 + 1.5 * (0.25 + 0.75 * (2 / 1.5))
 *       = 2 + 1.5 * (0.25 + 1.0) = 2 + 1.5 * 1.25 = 3.875.
 * score = idf * (f * (k1 + 1)) / denom
 *       = 0.6931471805599453 * (2 * 2.5) / 3.875
 *       = 0.6931471805599453 * 5 / 3.875
 *       = 0.8943834587870262.
 *
 * Chunk "dog" never contains "cat", so its score is exactly 0: BM25
 * only sums over terms the chunk actually contains.
 */
{
  const chunks = [
    { id: 'c0', docId: 'd0', docTitle: 'D0', index: 0, start: 0, end: 7, text: 'cat cat' },
    { id: 'c1', docId: 'd1', docTitle: 'D1', index: 0, start: 0, end: 3, text: 'dog' },
  ];
  const ranked = bm25Score('cat', chunks);
  const byId = Object.fromEntries(ranked.map((r) => [r.chunk.id, r.score]));
  const expectedScore = 0.8943834587870262;
  expect('bm25 hand computed', Math.abs(byId.c0 - expectedScore) < 1e-9, `bm25 gave ${byId.c0} for "cat cat", expected ${expectedScore}`);
  expect('bm25 no match is zero', byId.c1 === 0, `bm25 gave ${byId.c1} for "dog" against query "cat", expected exactly 0`);
  expect('bm25 sorted', ranked[0].chunk.id === 'c0', 'bm25 did not sort the higher scoring chunk first');
  console.log(`  bm25 hand computed case: "cat cat" scores ${byId.c0.toFixed(10)}, matches the worked arithmetic in the comment above exactly`);
}

/* ---- 5. TF-IDF cosine sanity --------------------------------------- */
// A chunk whose text is exactly the query, token for token, must have
// an identical term vector to the query, so the cosine similarity is
// mathematically forced to 1: dot(v, v) / (norm(v) * norm(v)) = 1.
{
  const chunks = [
    { id: 'same', docId: 'd0', docTitle: 'D0', index: 0, start: 0, end: 20, text: 'quarterly rotation policy' },
    { id: 'unrelated', docId: 'd1', docTitle: 'D1', index: 0, start: 0, end: 10, text: 'zebra mountain kite' },
  ];
  const ranked = tfidfScore('quarterly rotation policy', chunks);
  const same = ranked.find((r) => r.chunk.id === 'same');
  expect('tfidf identical text is cosine 1', Math.abs(same.score - 1) < 1e-9, `identical token sets should give cosine similarity 1, got ${same.score}`);
}

/* ---- 6. Ranking is deterministic ----------------------------------- */
{
  const chunks = chunkCorpus(CORPUS, { strategy: 'paragraph', chunkSize: 2000, overlap: 0 });
  for (const method of ['bm25', 'tfidf', 'ngram']) {
    const first = rankChunks(method, 'How do we refund a Customer?', chunks);
    const second = rankChunks(method, 'How do we refund a Customer?', chunks);
    const same = first.every((r, i) => r.chunk.id === second[i].chunk.id && r.score === second[i].score);
    expect('ranking deterministic', same, `${method} produced different results on two runs over identical input`);
  }
  console.log('  ranking determinism: bm25, tfidf, and ngram each reproduced identical output on a second run');
}

/* ---- 7. Changing chunk size changes the retrieved set -------------- */
{
  const doc = CORPUS.find((d) => d.id === 'data-retention-policy');
  const small = chunkDocument(doc, { strategy: 'sentence', chunkSize: 150, overlap: 0 });
  const large = chunkDocument(doc, { strategy: 'sentence', chunkSize: 1400, overlap: 0 });
  expect('chunk size changes chunk count', small.length !== large.length, `sentence chunking at size 150 and 1400 both produced ${small.length} chunks, expected different counts`);
  expect('large chunk size covers the doc in one piece', large.length === 1, `size 1400 should fit this ${doc.text.length} character document in one chunk, got ${large.length}`);

  const query = SAMPLE_QUERIES.find((s) => s.id === 'retention-and-encryption').query;
  const smallRanked = bm25Score(query, chunkCorpus(CORPUS, { strategy: 'sentence', chunkSize: 150, overlap: 0 }));
  const largeRanked = bm25Score(query, chunkCorpus(CORPUS, { strategy: 'sentence', chunkSize: 1400, overlap: 0 }));
  const smallTopIds = smallRanked.slice(0, 3).map((r) => r.chunk.id).join(',');
  const largeTopIds = largeRanked.slice(0, 3).map((r) => r.chunk.id).join(',');
  expect('chunk size changes retrieved set', smallTopIds !== largeTopIds, 'the top 3 chunk ids were identical at both chunk sizes, so chunk size had no visible effect on this query');
  console.log(`  chunk size sensitivity: size 150 top 3 is [${smallTopIds}], size 1400 top 3 is [${largeTopIds}]`);
}

/* ==================================================================
   8. THE IMPORTANT ONE. The documented lexical failure is real.

   Uses the exact configurations sampleState ships, via runForState,
   so this proves the behavior the tool actually presents to a user
   rather than a hand picked configuration chosen to make the point.
   ================================================================== */
{
  const state = sampleState('refund-paraphrase');
  const sample = SAMPLE_QUERIES.find((s) => s.id === 'refund-paraphrase');
  const resultA = runForState(state, 'a');
  const resultB = runForState(state, 'b');

  expect('lexical failure: wrong top rank, config A', resultA.ranked[0].chunk.docId !== sample.expectedDocId, `config A ranked ${resultA.ranked[0].chunk.docId} first, expected the failure to put the wrong document on top`);
  expect('lexical failure: wrong top rank, config B', resultB.ranked[0].chunk.docId !== sample.expectedDocId, `config B ranked ${resultB.ranked[0].chunk.docId} first, expected the failure to put the wrong document on top`);
  expect('lexical failure: correct source excluded under fine chunking', !resultA.selected.some((s) => s.chunk.docId === sample.expectedDocId), `config A selected a chunk from ${sample.expectedDocId} even though the failure requires it to be pushed out of the results entirely`);
  expect('lexical failure: correct source recovers under coarse chunking', resultB.selected.some((s) => s.chunk.docId === sample.expectedDocId), `config B never surfaced a chunk from ${sample.expectedDocId}, so the comparison this sample teaches did not hold`);
  console.log(`  lexical failure proven: config A selected [${resultA.selected.map((s) => s.chunk.docId).join(', ')}], config B selected [${resultB.selected.map((s) => s.chunk.docId).join(', ')}], neither ranks ${sample.expectedDocId} first`);
}

// The discriminating half of the proof: the well matched sample query
// must NOT trip the same failure, or the detector is not real, it
// always reports a miss regardless of the query.
{
  const state = sampleState('rollback-steps');
  const sample = SAMPLE_QUERIES.find((s) => s.id === 'rollback-steps');
  const resultA = runForState(state, 'a');
  const resultB = runForState(state, 'b');
  expect('well matched query succeeds, config A', resultA.ranked[0].chunk.docId === sample.expectedDocId, `config A ranked ${resultA.ranked[0].chunk.docId} first for the well matched query, expected ${sample.expectedDocId}`);
  expect('well matched query succeeds, config B', resultB.ranked[0].chunk.docId === sample.expectedDocId, `config B ranked ${resultB.ranked[0].chunk.docId} first for the well matched query, expected ${sample.expectedDocId}`);
  console.log(`  discrimination proven: the well matched query ranks ${sample.expectedDocId} first in both configs, so the lexical failure above is specific to that query, not a blanket miss`);
}

/* ---- 9. Chunk size sensitivity on the third sample query ----------- */
{
  const state = sampleState('retention-and-encryption');
  const resultA = runForState(state, 'a');
  const resultB = runForState(state, 'b');
  const docIdsA = new Set(resultA.selected.map((s) => s.chunk.docId));
  expect('retention query top match, config A', resultA.ranked[0].chunk.docId === 'data-retention-policy', 'config A did not rank the retention document first');
  expect('retention query top match, config B', resultB.ranked[0].chunk.docId === 'data-retention-policy', 'config B did not rank the retention document first');
  expect('retention query fragments under fine chunking', resultA.selected.length >= 2 && [...docIdsA].length === 1, 'config A was expected to return multiple fragments from the same document');
  expect('retention query whole chunk under coarse chunking', resultB.selected[0].chunk.text.includes('35 days') && resultB.selected[0].chunk.text.toLowerCase().includes('encrypt'), 'config B chunk 0 was expected to contain both the retention figure and the encryption detail in one piece');
  const fineChunkHasBoth = resultA.selected.some((s) => /35 days/.test(s.chunk.text) && /encrypt/i.test(s.chunk.text));
  expect('retention query splits facts under fine chunking', !fineChunkHasBoth, 'config A was expected to split the retention figure and the encryption detail into separate chunks, but one chunk had both');
  console.log(`  chunk size lesson proven: config A returns ${resultA.selected.length} fragments with the two facts in separate chunks, config B returns one chunk containing both`);
}

/* ---- 10. Maximal marginal relevance actually diversifies ----------- */
{
  const mk = (id, text, score) => ({
    chunk: { id, docId: id, docTitle: id, index: 0, start: 0, end: text.length, text },
    score,
    matchedTerms: [],
    reason: '',
  });
  const ranked = [
    mk('c0', 'alpha beta gamma delta epsilon', 1.0),
    mk('c1', 'alpha beta gamma delta epsilon', 0.95), // identical text: maximal redundancy against c0
    mk('c2', 'zzz yyy xxx www vvv', 0.5), // disjoint vocabulary: genuinely different
  ];
  const plainTop2 = ranked.slice(0, 2).map((r) => r.chunk.id);
  const diversified = mmrRerank(ranked, 2, 0.5).map((r) => r.chunk.id);
  const pureRelevance = mmrRerank(ranked, 2, 1.0).map((r) => r.chunk.id);

  expect('mmr plain baseline picks the near duplicate', plainTop2.join(',') === 'c0,c1', 'test setup assumption broke: plain top 2 was expected to be the near duplicate pair');
  expect('mmr diversifies', diversified.join(',') === 'c0,c2', `mmr with lambda 0.5 picked [${diversified.join(', ')}], expected it to swap out the near duplicate c1 for the genuinely different c2`);
  expect('mmr lambda 1 matches plain ranking', pureRelevance.join(',') === plainTop2.join(','), 'lambda 1, which should ignore diversity entirely, produced a different order than plain ranking');
  console.log(`  mmr: plain top 2 is [${plainTop2.join(', ')}], lambda 0.5 top 2 is [${diversified.join(', ')}], lambda 1 top 2 matches plain ranking`);
}

/* ---- 11. Tool module contract: empty, sample, reset, validate ------ */
{
  const empty = emptyState();
  expect('empty state has no query', empty.query === '', 'emptyState should start with no query');
  expect('empty state uses sample corpus', empty.corpusSource === 'sample', 'emptyState should default to the sample corpus');

  const errorsOnEmpty = validate(empty);
  expect('validate empty', errorsOnEmpty.some((i) => i.severity === 'error'), 'an empty state with no query produced no validation error');

  const withSample = sampleState();
  expect('sample state has a query', withSample.query.trim().length > 0, 'sampleState should populate a query');
  expect('validate sample', validate(withSample).length === 0, 'a freshly loaded sample state produced validation issues');

  const resetState = reset();
  expect('reset equals empty', JSON.stringify(resetState) === JSON.stringify(emptyState()), 'reset() should return to the same shape as emptyState()');

  const customEmpty = { ...empty, corpusSource: 'custom', customText: '   ' };
  expect('validate custom blank', validate(customEmpty).some((i) => i.field === 'customText'), 'blank custom text with custom source selected produced no warning');
}

/* ---- 12. Custom corpus, pasted text stays local and bounded -------- */
{
  const blank = { ...emptyState(), corpusSource: 'custom', customText: '' };
  expect('custom blank yields no documents', getCorpus(blank).length === 0, 'blank custom text should yield zero documents rather than an empty document');

  const pasted = { ...emptyState(), corpusSource: 'custom', customText: 'The archive is stored offline. It never leaves this browser tab.' };
  const docs = getCorpus(pasted);
  expect('custom text becomes one document', docs.length === 1, 'pasted custom text should become exactly one document');
  expect('custom text preserved verbatim', docs[0].text === pasted.customText, 'the pasted document text does not match what was typed');

  const huge = { ...emptyState(), corpusSource: 'custom', customText: 'x'.repeat(MAX_CUSTOM_TEXT_LENGTH + 5000) };
  const hugeDocs = getCorpus(huge);
  expect('custom text capped', hugeDocs[0].text.length === MAX_CUSTOM_TEXT_LENGTH, `pasted text should be capped at ${MAX_CUSTOM_TEXT_LENGTH} characters, got ${hugeDocs[0].text.length}`);
}

/* ---- 13. Answer template and missed evidence ----------------------- */
{
  const chunks = chunkCorpus(CORPUS, { strategy: 'paragraph', chunkSize: 2000, overlap: 0 });
  const noQuery = runRetrieval(CORPUS, '', { chunking: { strategy: 'paragraph', chunkSize: 2000, overlap: 0 }, rankMethod: 'bm25', topK: 3, scoreThreshold: 0, useMmr: false, mmrLambda: 0.5 });
  expect('answer template empty query', /enter a query/i.test(noQuery.answerTemplate), 'an empty query should produce a template that asks for one');

  const impossible = runRetrieval(CORPUS, 'rollback deployment', { chunking: { strategy: 'paragraph', chunkSize: 2000, overlap: 0 }, rankMethod: 'bm25', topK: 3, scoreThreshold: 1000, useMmr: false, mmrLambda: 0.5 });
  expect('answer template no results', impossible.selected.length === 0 && /no chunk cleared/i.test(impossible.answerTemplate), 'an impossibly high threshold should produce zero selected chunks and say so in the template');
  expect('missed evidence populated when nothing selected', impossible.missed.length > 0, 'with everything filtered out, the missed evidence list should report the highest scoring chunks and why they did not make it');

  const normal = runRetrieval(CORPUS, 'roll back a failed deployment', { chunking: { strategy: 'paragraph', chunkSize: 2000, overlap: 0 }, rankMethod: 'bm25', topK: 2, scoreThreshold: 0, useMmr: false, mmrLambda: 0.5 });
  expect('answer template cites selected chunks', normal.selected.every((s, i) => normal.answerTemplate.includes(`${i + 1}. ${s.chunk.docTitle}`)), 'the answer template should number and title every selected chunk as a citation');
  expect('chunks list independent of ranking', normal.chunks.length === chunks.length, 'the full chunk list returned alongside a result should not be filtered by the ranking method');
}

/* ---- Report ------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`RAG LAB LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('RAG LAB LOGIC: CLEAN');
