import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, createMasker, detectLanguage, maskPII } from '../src/api/mockEngine.js';
import { ticketTitle } from '../src/lib/format.js';
import { ApiError, describeError, normalizeTriage, serverMessage } from '../src/api/normalize.js';
import { SAMPLES, OUTAGE_BURST } from '../src/data/samples.js';
import { buildSeedTickets } from '../src/data/mockTickets.js';

const codes = (r) => r.gate.reasons.map((x) => x.code);

test('demo samples land on their scripted gate decision', () => {
  const want = {
    'de-vpn': ['ESCALATE_ONCALL', 'HIGH_PRIORITY_INCIDENT'],
    'en-password': ['AUTO_DRAFT'],
    'en-refund-injection': ['HUMAN_REVIEW', 'PROMPT_INJECTION', 'UNSUPPORTED_REQUEST'],
    'de-ransomware': ['ESCALATE_ONCALL', 'SECURITY_INCIDENT'],
    'en-gdpr': ['HUMAN_REVIEW', 'LEGAL_OR_COMPLIANCE'],
    'fr-login': ['HUMAN_REVIEW', 'UNSUPPORTED_LANGUAGE'],
    'en-pii': ['HUMAN_REVIEW', 'UNSUPPORTED_REQUEST'],
  };
  for (const s of SAMPLES) {
    const [decision, ...reasons] = want[s.id];
    const r = analyze({ ticket_id: 'T', subject: s.subject, body: s.body });
    assert.equal(r.gate.decision, decision, s.id);
    for (const c of reasons) assert.ok(codes(r).includes(c), `${s.id} should fire ${c}, got ${codes(r)}`);
  }
  // The Live triage "personal data" scenario must show every kind of masking it promises.
  const pii = SAMPLES.find((s) => s.id === 'en-pii');
  const masked = analyze({ ticket_id: 'T', subject: pii.subject, body: pii.body }).pii.masked.map((m) => m.type).sort();
  assert.deepEqual(masked, ['CARD', 'EMAIL', 'IBAN', 'PHONE']);
});

test('gate rule: any P1 escalates, else any reason holds, else auto-draft', () => {
  for (const t of buildSeedTickets()) {
    const sev = t.gate.reasons.map((x) => x.severity);
    const expected = sev.includes('P1') ? 'ESCALATE_ONCALL' : sev.length ? 'HUMAN_REVIEW' : 'AUTO_DRAFT';
    assert.equal(t.gate.decision, expected, t.ticket_id);
  }
});

test('outage burst tickets join the cluster and escalate', () => {
  for (const s of OUTAGE_BURST) {
    const r = analyze({ ticket_id: 'T', ...s }, { burst: true });
    assert.equal(r.gate.decision, 'ESCALATE_ONCALL', s.subject);
    assert.ok(codes(r).includes('ACTIVE_OUTAGE'), s.subject);
    assert.equal(r.burst?.cluster_id, 'BURST-VPN-SERVICE');
    assert.ok(r.burst.ticket_count >= 1 && r.burst.queue && r.burst.lead_term === 'vpn');
  }
});

test('keywords do not over-fire on harmless mentions', () => {
  assert.equal(analyze({ subject: 'Thanks', body: 'the vpn works great now' }).gate.decision !== 'ESCALATE_ONCALL', true);
  assert.ok(!codes(analyze({ subject: 'Training', body: 'We would like phishing awareness training for staff.' })).includes('SECURITY_INCIDENT'));
});

// Same table as the Go gateway's tests, so the mock and backend/internal/pii agree. It lives in backend/
// because the Go package owns the rules; this test needs the whole repo checked out.
const PII_CASES = JSON.parse(readFileSync(new URL('../../backend/internal/pii/testdata/cases.json', import.meta.url), 'utf8'));

test('PII masking matches the gateway cases', () => {
  for (const c of PII_CASES) {
    const r = maskPII(c.in);
    assert.equal(r.text, c.out, c.name);
    assert.deepEqual(r.entities, c.masked, c.name);
  }
});

test('PII numbering is shared by subject and body', () => {
  const r = analyze({ subject: 'Mail a@b.de', body: 'or c@d.de or a@b.de, call 030 1234567' });
  assert.equal(r.subject, 'Mail [EMAIL_1]');
  assert.equal(r.body, 'or [EMAIL_2] or [EMAIL_1], call [PHONE_1]');
  assert.deepEqual(r.pii.masked, [{ type: 'EMAIL', count: 3 }, { type: 'PHONE', count: 1 }]);
  assert.deepEqual(createMasker().entities(), []);
});

test('language detection', () => {
  assert.equal(detectLanguage('Hello, my password reset email never arrives. Can you help?').code, 'en');
  assert.equal(detectLanguage('Hallo, ich kann mich nicht anmelden. Bitte um Hilfe.').code, 'de');
  assert.equal(detectLanguage('Bonjour, je ne peux pas me connecter depuis hier.').code, 'fr');
  assert.equal(detectLanguage('Ciao, non posso accedere al mio account. Grazie.').code, 'it');
});

test('normalizeTriage accepts the mock shape unchanged in substance', () => {
  const r = analyze({ ticket_id: 'T1', subject: 'Password reset', body: 'I forgot my password' });
  const n = normalizeTriage(r);
  assert.equal(n.ticket_id, 'T1');
  assert.equal(n.gate.decision, r.gate.decision);
  assert.deepEqual(n.draft.validation, r.draft.validation);
});

test('normalizeTriage rejects responses the UI cannot use, with readable errors', () => {
  const ok = analyze({ ticket_id: 'T1', subject: 'x', body: 'y' });
  const bad = [null, [], {}, { ...ok, ticket_id: undefined }, { ...ok, gate: { decision: 'MAYBE' } }, { ...ok, classification: {} }];
  for (const b of bad) {
    assert.throws(() => normalizeTriage(b), (e) => e instanceof ApiError && e.code === 'BAD_RESPONSE' && /missing/.test(e.message));
  }
});

test('normalizeTriage fills optional fields so views never crash', () => {
  const n = normalizeTriage(
    { ticket_id: 7, gate: { decision: 'HUMAN_REVIEW', reasons: [{ code: 'NO_PRECEDENT' }] }, classification: { type: 'Incident', queue: 'IT Support', priority: 'High' }, draft: null },
    { subject: 'S', body: 'B' },
  );
  assert.equal(n.ticket_id, '7');
  assert.equal(n.subject, 'S');
  assert.equal(n.classification.priority.label, 'high');
  assert.equal(n.gate.reasons[0].severity, 'P2');
  assert.deepEqual(n.precedents, []);
  assert.equal(n.draft.validation.passed, false);
  assert.ok(n.created_at && n.language.code);
});

test('retrieval.route: one confident queue, two otherwise, all queues when the match is weak', () => {
  const pw = analyze({ ticket_id: 'T1', subject: 'Password reset', body: 'I forgot my password, please help' });
  assert.equal(pw.retrieval.route.queues.length, 3);
  assert.deepEqual(pw.retrieval.route.searched, ['IT Support']);
  assert.equal(pw.retrieval.route.fallback_global, false);
  assert.equal(pw.retrieval.top_similarity, pw.precedents[0].similarity);
  const vague = analyze({ ticket_id: 'T2', subject: 'Question about something', body: 'Hi there, quick question.' });
  assert.equal(vague.retrieval.route.fallback_global, true);
  assert.deepEqual(vague.retrieval.route.searched, []);

  const n = normalizeTriage({ ...pw, retrieval: { route: { queues: [{ queue: 'IT Support', score: 'x' }, null], searched: ['IT Support'], fallback_global: 'yes' } } });
  assert.deepEqual(n.retrieval.route, { queues: [{ queue: 'IT Support', score: null }], searched: ['IT Support'], fallback_global: false });
  assert.deepEqual(normalizeTriage({ ...pw, retrieval: undefined }).retrieval.route, { queues: [], searched: [], fallback_global: false });
});

test('contract v1 fields the console reads: holding mode, empty precedents, warnings, request_id', () => {
  const base = analyze({ ticket_id: 'T3', subject: 'x', body: 'y' });
  const holding = normalizeTriage({
    ...base,
    precedents: [],
    retrieval: { route: { queues: [], searched: [], fallback_global: true }, top_similarity: 0, k: 5 },
    draft: { ...base.draft, mode: 'holding', citations: [] },
    warnings: [{ stage: 'draft', code: 'STUB', message: 'draft stage is a stub' }, { nope: 1 }],
  });
  assert.equal(holding.draft.mode, 'holding');
  assert.deepEqual(holding.precedents, []);
  assert.equal(holding.retrieval.top_similarity, 0);
  assert.deepEqual(holding.warnings, [{ stage: 'draft', code: 'STUB', message: 'draft stage is a stub' }]);
  assert.match(holding.request_id, /^req_[0-9a-f]{12}$/);
  assert.equal(normalizeTriage({ ...base, draft: { ...base.draft, mode: 'weird' } }).draft.mode, 'generated');
  assert.equal(describeError(new ApiError('Engine timed out.', { requestId: 'req_0123456789ab' })), 'Engine timed out. (request req_0123456789ab)');
});

test('no precedent: empty list and a holding reply that cites nothing', () => {
  const r = analyze({ ticket_id: 'T4', subject: 'Question about something', body: 'Hi there, quick question.' });
  assert.deepEqual(r.precedents, []);
  assert.equal(r.draft.mode, 'holding');
  assert.deepEqual(r.draft.citations, []);
  assert.equal(r.retrieval.top_similarity, 0);
  assert.ok(r.gate.reasons.some((x) => x.code === 'NO_PRECEDENT'));
  assert.notEqual(r.gate.decision, 'AUTO_DRAFT');
});

test('ticketTitle falls back to the body when there is no subject', () => {
  assert.equal(ticketTitle({ subject: 'VPN down', body: 'x' }), 'VPN down');
  assert.equal(ticketTitle({ subject: '', body: 'Mein  Drucker\n druckt nicht' }), 'Mein Drucker druckt nicht');
  assert.equal(ticketTitle({ subject: ' ', body: 'a'.repeat(100) }), `${'a'.repeat(80)}…`);
  assert.equal(ticketTitle({ subject: '', body: '' }), '(no subject)');
});

test('serverMessage reads gateway and FastAPI error shapes', () => {
  assert.equal(serverMessage({ error: { message: 'bad' } }), 'bad');
  assert.equal(serverMessage({ detail: 'nope' }), 'nope');
  assert.equal(serverMessage({ detail: [{ msg: 'field required' }, { msg: 'too long' }] }), 'field required; too long');
  assert.equal(serverMessage(null), null);
});
