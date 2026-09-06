// Search abstraction (spec §84). The engine is not coupled to any one provider.
// Phase 3 ships the mock; a real provider (Exa / Brave / Bing / SerpAPI) drops in
// behind this same interface with an API key.

import type { SourceType } from '../../domain/types.ts';

export interface SourceDoc {
  url: string;
  domain: string;
  title: string;
  text: string;
  sourceType: SourceType;
}

export interface SourceHit {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  text: string;
  sourceType: SourceType;
}

export interface SourceSearchProvider {
  readonly name: string;
  /** Honest description of what was actually searched (spec §86). */
  readonly coverageNote: string;
  search(query: string, opts?: { limit?: number }): Promise<SourceHit[]>;
}

const DOMAIN_TYPE: Array<[RegExp, SourceType]> = [
  [/\.edu(\.|$)|arxiv\.org|doi\.org|\.ac\.[a-z]{2}$|jstor\.org|nature\.com|sciencedirect/i, 'academic'],
  [/\.gov(\.|$)|\.gov\.[a-z]{2}$|un\.org|who\.int|worldbank\.org|oecd\.org|europa\.eu/i, 'government'],
  [/reuters\.com|apnews\.com|bbc\.(co\.uk|com)|nytimes\.com|theguardian\.com|economist\.com|ft\.com|wsj\.com|npr\.org/i, 'news'],
  [/wikipedia\.org|britannica\.com|investopedia\.com/i, 'reference'],
  [/medium\.com|substack\.com|wordpress\.com|blogspot\.com|dev\.to/i, 'blog'],
  [/reddit\.com|stackexchange\.com|stackoverflow\.com|quora\.com|ycombinator\.com/i, 'forum'],
  [/twitter\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com|threads\.net/i, 'social'],
];

export function classifyDomain(domain: string): SourceType {
  for (const [re, type] of DOMAIN_TYPE) if (re.test(domain)) return type;
  return domain.endsWith('.com') || domain.endsWith('.io') || domain.endsWith('.net') ? 'corporate' : 'unknown';
}

export const CREDIBILITY: Record<SourceType, number> = {
  academic: 0.95,
  government: 0.9,
  news: 0.75,
  reference: 0.6,
  corporate: 0.5,
  unknown: 0.4,
  blog: 0.35,
  forum: 0.25,
  social: 0.2,
};
