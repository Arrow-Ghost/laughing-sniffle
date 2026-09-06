// A deterministic, offline stand-in for a real web search (spec §119). It ranks
// a small seeded corpus by shingle overlap with the query. Swap in a real
// provider behind SourceSearchProvider without touching the engine.

import { classifyDomain } from './SourceSearchProvider.ts';
import type { SourceDoc, SourceHit, SourceSearchProvider } from './SourceSearchProvider.ts';
import { containment, sentences, shingles } from '../text.ts';

export const SEED_CORPUS: SourceDoc[] = [
  {
    url: 'https://www.imf.org/en/Publications/WEO/trade-and-workers',
    domain: 'imf.org',
    title: 'Trade Openness and Labour Market Outcomes',
    sourceType: 'government',
    text:
      'When economies open to trade without adjustment assistance for displaced workers, the losses are concentrated in specific communities while the gains are diffuse and spread thinly across consumers. The net welfare effect over the last decade has been positive but the distribution has been deeply uneven. Regulatory credibility matters: carbon markets collapse when the underlying regulatory commitment is not believed by participants.',
  },
  {
    url: 'https://en.wikipedia.org/wiki/Comparative_advantage',
    domain: 'en.wikipedia.org',
    title: 'Comparative advantage — Wikipedia',
    sourceType: 'reference',
    text:
      'The law of comparative advantage describes how, under free trade, an agent will produce more of and consume less of a good for which it has a comparative advantage. Comparative advantage is the economic reality describing the work gains from trade for individuals, firms, or nations.',
  },
  {
    url: 'https://www.reuters.com/markets/trade-policy-working-people',
    domain: 'reuters.com',
    title: 'Analysis: Has trade policy helped working people?',
    sourceType: 'news',
    text:
      'The evidence from the last decade is honestly pretty mixed, but on balance most economists argue that liberalisation did not help the median worker in advanced economies. Import competition produced sharp, localised job losses that adjustment programmes never fully offset.',
  },
  {
    url: 'https://climatepolicyblog.substack.com/p/carbon-markets',
    domain: 'climatepolicyblog.substack.com',
    title: 'Why carbon markets keep failing',
    sourceType: 'blog',
    text:
      'Carbon markets collapse when regulatory credibility erodes. If firms expect the cap to be loosened under political pressure, the price signal disappears and the whole mechanism unwinds. This is the single most important design lesson from the last twenty years of emissions trading.',
  },
  {
    url: 'https://www.reddit.com/r/debate/comments/trade_case',
    domain: 'reddit.com',
    title: 'r/debate — my trade policy case file',
    sourceType: 'forum',
    text:
      'Claim: trade policy has not helped workers. Example: the China shock. Statistic: 2.4 million manufacturing jobs. Rebuttal to the growth argument: aggregate GDP gains do not reach displaced workers because retraining programmes have low take-up.',
  },
  {
    url: 'https://www.oecd.org/employment/adjustment-assistance-review',
    domain: 'oecd.org',
    title: 'Trade Adjustment Assistance: A Review',
    sourceType: 'government',
    text:
      'Programmes that pair open markets with serious adjustment assistance — wage insurance, mobility grants, and portable benefits — show materially better outcomes for affected workers than trade liberalisation alone.',
  },
];

export class MockSourceSearchProvider implements SourceSearchProvider {
  readonly name = 'mock';
  readonly coverageNote =
    'Local demonstration corpus of 6 seeded documents — not a live web search. ' +
    'A real deployment plugs a search provider in behind the same interface.';

  private readonly corpus: Array<SourceDoc & { grams: Set<string> }>;

  constructor(docs: SourceDoc[] = SEED_CORPUS) {
    this.corpus = docs.map((d) => ({ ...d, grams: shingles(d.text, 3) }));
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<SourceHit[]> {
    const qGrams = shingles(query, 3);
    const scored = this.corpus
      .map((d) => {
        const score = containment(qGrams, d.grams);
        const best = bestSentence(query, d.text);
        return { d, score, snippet: best };
      })
      .filter((x) => x.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 3);

    return scored.map(({ d, snippet }) => ({
      url: d.url,
      domain: d.domain,
      title: d.title,
      snippet,
      text: d.text,
      sourceType: d.sourceType ?? classifyDomain(d.domain),
    }));
  }
}

function bestSentence(query: string, docText: string): string {
  const q = shingles(query, 3);
  let best = '';
  let bestScore = -1;
  for (const s of sentences(docText)) {
    const score = containment(q, shingles(s, 3));
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best || docText.slice(0, 200);
}
