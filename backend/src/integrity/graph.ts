// Integrity source graph (spec §62). A pure view over an IntegrityCase — the
// participant in the centre, edges to the external sources and other submissions
// that their wording overlaps with. No new storage.

import type { GraphEdge, GraphNode, IntegrityCase, SourceGraph } from '../domain/types.ts';

export function buildSourceGraph(c: IntegrityCase): SourceGraph {
  const nodes: GraphNode[] = [
    { id: 'participant', kind: 'participant', label: 'this submission', meta: { sessionId: c.sessionId } },
  ];
  const edges: GraphEdge[] = [];

  // strongest match per source domain
  const byDomain = new Map<string, (typeof c.sourceMatches)[number]>();
  for (const m of c.sourceMatches) {
    const cur = byDomain.get(m.domain);
    if (!cur || m.significance > cur.significance) byDomain.set(m.domain, m);
  }
  for (const [domain, m] of byDomain) {
    const id = `source:${domain}`;
    nodes.push({ id, kind: 'source', label: domain, meta: { sourceType: m.sourceType, url: m.sourceUrl, credibility: m.credibility } });
    edges.push({
      from: 'participant',
      to: id,
      kind: 'phrase-similarity',
      weight: m.significance,
      evidence: `“${m.phrase.slice(0, 100)}${m.phrase.length > 100 ? '…' : ''}” — ${Math.round(m.exactSimilarity * 100)}% word overlap, ${m.quotationClass}`,
    });
  }

  for (const p of c.participantMatches) {
    const id = `other:${p.otherSessionId}`;
    nodes.push({ id, kind: 'other-participant', label: p.otherLabel, meta: { sessionId: p.otherSessionId } });
    edges.push({
      from: 'participant',
      to: id,
      kind: 'phrase-similarity',
      weight: p.similarity,
      evidence: p.note,
    });
  }

  return { caseId: c.id, nodes, edges };
}
