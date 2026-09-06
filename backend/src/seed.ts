import type { StorageProvider } from './storage/StorageProvider.ts';
import type { AIGateway } from './ai/AIGateway.ts';
import type { SessionManager } from './session.ts';
import type { JudgeEngine } from './judge-engine/index.ts';
import type { IntegrityEngine } from './integrity/index.ts';
import type { CoachEngine } from './coach/index.ts';
import { createEvent, createRound, createParticipant, createSession, createTranscriptSegment } from './domain/entities.ts';
import { rubricFromPreset } from './domain/rubrics.ts';

export async function seedDemoData(opts: {
  storage: StorageProvider;
  ai: AIGateway;
  sessions: SessionManager;
  judge: JudgeEngine;
  integrity: IntegrityEngine;
  coach: CoachEngine;
}) {
  const { storage, sessions, judge, integrity, coach } = opts;
  const existingEvents = storage.listEvents();
  let ev = existingEvents.find((e) => e.name.includes('National Debate Championship'));
  if (ev) {
    const existingSessions = storage.listSessions({ eventId: ev.id });
    if (existingSessions.length > 0 && existingSessions.some((s) => storage.listSegments(s.id).length > 0)) {
      return;
    }
  }

  console.log('[shadowadj] Seeding demo event, sessions, judge evaluations, and integrity cases...');

  if (!ev) {
    ev = createEvent({ name: 'National Debate Championship 2026', type: 'debate' });
    storage.createEvent(ev);
  }

  const existingRounds = storage.listRoundsByEvent(ev.id);
  let r1 = existingRounds.find((r) => r.index === 1);
  if (!r1) {
    r1 = createRound({ eventId: ev.id, index: 1, name: 'Grand Final Round' });
    storage.createRound(r1);
  }

  const existingParticipants = storage.listParticipantsByEvent(ev.id);
  let p1 = existingParticipants.find((p) => p.displayName.includes('Alex Rivera'));
  if (!p1) {
    p1 = createParticipant({ eventId: ev.id, displayName: 'Alex Rivera (Affirmative)', seat: '1' });
    storage.createParticipant(p1);
  }

  let p2 = existingParticipants.find((p) => p.displayName.includes('Jordan Chen'));
  if (!p2) {
    p2 = createParticipant({ eventId: ev.id, displayName: 'Jordan Chen (Negative)', seat: '2' });
    storage.createParticipant(p2);
  }

  let rubric = ev.rubricId ? storage.getRubric(ev.rubricId) : null;
  if (!rubric) {
    rubric = storage.createRubric(rubricFromPreset('debate', ev.id));
    storage.setEventRubric(ev.id, rubric.id);
  }

  // 2. Demo Session 1 (Affirmative)
  const s1Entity = createSession({
    mode: 'debate-practice',
    label: 'Grand Final — Affirmative Rebuttal',
    consent: { speakerAcknowledged: true, secondPartyAcknowledged: true },
    eventId: ev.id,
    participantId: p1.id,
    roundId: r1.id,
  });
  s1Entity.status = 'ended';
  s1Entity.startedAt = Date.now() - 900_000;
  s1Entity.endedAt = Date.now() - 300_000;
  storage.createSession(s1Entity);

  const text1 = [
    { text: 'Good evening Mr. Chairman, esteemed judges, and members of the gallery. Today we stand firmly in favor of the motion.', t0: 0, t1: 8000 },
    { text: 'First, according to recent economic data from the Congressional Budget Office, infrastructure investment yields a three-fold economic multiplier over a ten-year horizon.', t0: 8500, t1: 19000 },
    { text: 'My opponent argued that initial capital expenditure will overburden local budgets. However, this fails to account for long-term federal matching grants and reduced maintenance overhead.', t0: 20000, t1: 34000 },
    { text: 'To signpost our key points: one, immediate job creation; two, sustainable energy resilience; and three, long-term fiscal solvency.', t0: 35000, t1: 47000 },
    { text: 'In conclusion, we cannot afford inaction. We urge a clear vote in favor of the motion. Thank you.', t0: 48000, t1: 56000 },
  ];

  for (const item of text1) {
    storage.appendSegment(
      createTranscriptSegment({
        sessionId: s1Entity.id,
        text: item.text,
        t0: item.t0,
        t1: item.t1,
        isFinal: true,
      }),
    );
  }

  // 3. Demo Session 2 (Negative)
  const s2Entity = createSession({
    mode: 'debate-practice',
    label: 'Grand Final — Negative Constructive',
    consent: { speakerAcknowledged: true, secondPartyAcknowledged: true },
    eventId: ev.id,
    participantId: p2.id,
    roundId: r1.id,
  });
  s2Entity.status = 'ended';
  s2Entity.startedAt = Date.now() - 600_000;
  s2Entity.endedAt = Date.now() - 100_000;
  storage.createSession(s2Entity);

  const text2 = [
    { text: 'Mr. Chairman, ladies and gentlemen. The affirmative proposal presents an optimistic vision, but it ignores crucial implementation bottlenecks.', t0: 0, t1: 9000 },
    { text: 'According to the OECD 2025 fiscal report, debt service obligations currently constrain local municipal budgets by over forty percent.', t0: 9500, t1: 21000 },
    { text: 'If we allocate capital to unproven regional projects today, we risk crowding out municipal bonds and inflating local borrowing costs.', t0: 22000, t1: 33000 },
    { text: 'Therefore, we urge judges to reject the affirmative motion and support our counter-plan for targeted tax credits instead. Thank you.', t0: 34000, t1: 45000 },
  ];

  for (const item of text2) {
    storage.appendSegment(
      createTranscriptSegment({
        sessionId: s2Entity.id,
        text: item.text,
        t0: item.t0,
        t1: item.t1,
        isFinal: true,
      }),
    );
  }

  // Generate Judge Evaluations, Integrity, and Coach Plans for both sessions
  try {
    const eval1 = await judge.evaluate({ sessionId: s1Entity.id, rubric });
    await judge.evaluate({ sessionId: s2Entity.id, rubric });
    await integrity.analyzeSession(s1Entity.id);
    await integrity.analyzeSession(s2Entity.id);
    await coach.plan({ sessionId: s1Entity.id, evaluationId: eval1.id });
    console.log('[shadowadj] Demo seeding complete!');
  } catch (e: any) {
    console.log('[shadowadj] Demo seeding partial (AI evaluation skipped if offline):', e.message);
  }
}
