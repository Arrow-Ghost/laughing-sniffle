// The AI opponent (spec §57). Configurable, and it sees the whole exchange so
// far — session memory — so it can press on the participant's actual line.

import type { Part } from '@google/generative-ai';
import type { DrillExchange, OpponentConfig } from '../../domain/types.ts';

export interface OpponentTurnInput {
  config: OpponentConfig;
  topic: string;
  exchanges: DrillExchange[];
  lastArgument: string;
}

export function opponentTurnParts(i: OpponentTurnInput): Part[] {
  const history = i.exchanges
    .slice(-8)
    .map((e) => `${e.role === 'opponent' ? 'YOU' : 'THEM'}: ${e.text}`)
    .join('\n');
  return [
    {
      text: [
        `You are an opposing debater in a ${i.config.domain} debate. Topic: ${i.topic}.`,
        `Difficulty: ${i.config.difficulty}. Aggression: ${i.config.aggression}. Style: ${i.config.style}. Language: ${i.config.language}.`,
        'Press on the SPECIFIC line your opponent just took — do not reset to a generic case.',
        history ? `\nExchange so far:\n${history}` : '',
        `\nTheir latest argument:\n${i.lastArgument}`,
        '',
        'Give your next turn only — one focused challenge, 2-4 sentences, in character. No stage directions.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}
