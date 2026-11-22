// In-browser stand-in for gateway + engine so the console is never blocked (the gateway has its own, FS-03).
// Deterministic: the same subject/body always produces the same result.
// Results follow contract v1 (contracts/README.md, TriageResponse).

import { GATE_THRESHOLDS, QUEUES, REASONS } from '../lib/constants.js';

const { precedentSimilarity: SIM_THRESHOLD, confidenceFloor: CONF_FLOOR, highPriority: P_HIGH_THRESHOLD } = GATE_THRESHOLDS;

// ---------- deterministic randomness ----------
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r, lo, hi) => lo + r() * (hi - lo);
const round2 = (x) => Math.round(x * 100) / 100;

// ---------- keyword lists (EN + DE) ----------
const KW = {
  security: ['breach', 'hacked', 'ransomware', 'compromised', 'phishing attack', 'phishing link', 'phished', 'malware', 'unauthorized access', 'gehackt', 'angriff', 'verschlüsselt', 'lösegeld', 'datenleck', 'schadsoftware', 'kompromittiert'],
  outage: ['outage', 'is down', 'are down', 'server down', 'vpn down', 'not reachable', 'unreachable', 'cannot connect', "can't connect", 'ausgefallen', 'ausfall', 'nicht erreichbar', 'störung', 'keine verbindung'],
  money: ['refund', 'compensation', 'chargeback', 'money back', 'discount', 'pricing', 'contract terms', 'erstattung', 'rückerstattung', 'entschädigung', 'gutschrift', 'rabatt'],
  legal: ['lawyer', 'lawsuit', 'legal action', 'gdpr', 'dsgvo', 'delete all my data', 'delete my data', 'attorney', 'anwalt', 'klage', 'rechtliche schritte', 'daten löschen'],
  injection: ['ignore previous', 'ignore all previous', 'ignore your instructions', 'system prompt', 'you are now', 'disregard all', 'ignoriere alle', 'ignoriere die vorherigen'],
  billing: ['invoice', 'billing', 'payment', 'charged', 'vat', 'rechnung', 'zahlung', 'abbuchung'],
  password: ['password', 'locked out', 'login attempts', 'log in', 'sign in', '2fa', 'passwort', 'zurücksetzen', 'gesperrt', 'anmelden'],
  feature: ['feature request', 'feature', 'enhancement', 'would be great', 'vorschlag'],
  product: ['app', 'crash', 'crashes', 'update', 'version', 'install', 'installation', 'sync', 'synchronisiert', 'synchronisierung', 'absturz', 'desktop'],
};
const CATEGORY_ORDER = ['security', 'outage', 'money', 'legal', 'billing', 'password', 'feature', 'product'];

const kwRegex = (kw) => new RegExp(`(^|[^\\p{L}])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu');
const COMPILED = Object.fromEntries(Object.entries(KW).map(([k, list]) => [k, list.map((w) => [w, kwRegex(w)])]));
function firstHit(group, text) {
  for (const [w, re] of COMPILED[group]) if (re.test(text)) return w;
  return null;
}

// ---------- language ----------
const LANG_WORDS = {
  en: ['the', 'and', 'is', 'not', 'we', 'our', 'please', 'with', 'can', 'my', 'have', 'for', 'you', 'since', 'all'],
  de: ['der', 'die', 'das', 'und', 'nicht', 'ich', 'ist', 'wir', 'bitte', 'unser', 'unsere', 'seit', 'mit', 'kann', 'keine', 'für', 'auf', 'eine', 'haben', 'sind', 'hallo'],
  fr: ['bonjour', 'merci', 'je', 'nous', 'avec', 'votre', 'mon', 'depuis', 'pas', 'de', 'le', 'la'],
  es: ['hola', 'gracias', 'problema', 'nuestro', 'por', 'favor', 'cuenta', 'mi', 'el', 'los'],
  it: ['ciao', 'buongiorno', 'grazie', 'il', 'non', 'della', 'sono', 'abbiamo', 'posso', 'accedere', 'che', 'mio'],
};
export function detectLanguage(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  const scores = Object.fromEntries(Object.keys(LANG_WORDS).map((l) => [l, 0]));
  for (const w of words) for (const [l, list] of Object.entries(LANG_WORDS)) if (list.includes(w)) scores[l]++;
  if (/[äöüß]/i.test(text)) scores.de += 2;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [code, top] = ranked[0];
  if (top === 0) return { code: 'en', confidence: 0.55 };
  const margin = top - ranked[1][1];
  return { code, confidence: round2(Math.min(0.99, 0.72 + margin * 0.05)) };
}

// ---------- category profiles & precedent bank ----------
const PROFILE = {
  security: { type: 'Incident', queue: 'IT Support', priority: 'high', pHigh: 0.91, sim: 0.84, conf: 0.9 },
  outage: { type: 'Incident', queue: 'Service Outages and Maintenance', priority: 'high', pHigh: 0.88, sim: 0.88, conf: 0.89 },
  money: { type: 'Request', queue: 'Billing and Payments', priority: 'medium', pHigh: 0.27, sim: 0.79, conf: 0.8 },
  legal: { type: 'Request', queue: 'Customer Service', priority: 'medium', pHigh: 0.31, sim: 0.74, conf: 0.76 },
  billing: { type: 'Request', queue: 'Billing and Payments', priority: 'low', pHigh: 0.12, sim: 0.86, conf: 0.88 },
  password: { type: 'Request', queue: 'IT Support', priority: 'medium', pHigh: 0.21, sim: 0.91, conf: 0.92 },
  feature: { type: 'Change', queue: 'Product Support', priority: 'low', pHigh: 0.06, sim: 0.72, conf: 0.81 },
  product: { type: 'Problem', queue: 'Technical Support', priority: 'medium', pHigh: 0.3, sim: 0.8, conf: 0.84 },
  general: { type: 'Request', queue: 'General Inquiry', priority: 'low', pHigh: 0.1, sim: 0.24, conf: 0.38 },
};

const BANK = {
  security: [['TKT-00417', 'Ransomware note on file server', 'en'], ['TKT-02981', 'Account compromised after phishing email', 'en'], ['TKT-05520', 'Unbefugte Anmeldungen am Admin-Konto', 'de']],
  outage: [['TKT-02210', 'VPN gateway down for all remote staff', 'en'], ['TKT-04471', 'VPN-Verbindung bricht ständig ab', 'de'], ['TKT-06013', 'Klinik-Netzwerk nicht erreichbar', 'de']],
  money: [['TKT-01276', 'Requesting refund for annual plan', 'en'], ['TKT-05034', 'Compensation for downtime last week', 'en'], ['TKT-03890', 'Rückerstattung nach Kündigung', 'de']],
  legal: [['TKT-02647', 'GDPR data deletion request', 'en'], ['TKT-06120', 'Auskunftsersuchen nach DSGVO', 'de'], ['TKT-03455', 'Legal notice regarding contract', 'en']],
  billing: [['TKT-00933', 'Where can I download my invoice?', 'en'], ['TKT-04108', 'Doppelte Abbuchung auf Rechnung', 'de'], ['TKT-06655', 'Invoice shows wrong VAT', 'en']],
  password: [['TKT-01842', 'Password reset link not arriving', 'en'], ['TKT-03317', 'Locked out after too many attempts', 'en'], ['TKT-07702', 'Passwort zurücksetzen funktioniert nicht', 'de']],
  feature: [['TKT-01590', 'Feature request: dark mode', 'en'], ['TKT-04822', 'Vorschlag: Export als CSV', 'de'], ['TKT-07311', 'Enhancement: bulk edit', 'en']],
  product: [['TKT-00718', 'App crashes after update', 'en'], ['TKT-03602', 'Sync not working on desktop client', 'en'], ['TKT-05947', 'Installation schlägt unter Windows fehl', 'de']],
  general: [['TKT-02034', 'Question about support hours', 'en'], ['TKT-06408', 'Allgemeine Anfrage zum Produkt', 'de'], ['TKT-04563', 'Who is my account manager?', 'en']],
};

// ---------- draft templates ----------
const SIGN = { en: '\n\nBest regards,\nSupport Team', de: '\n\nMit freundlichen Grüßen\nIhr Support-Team' };
const HELLO = { en: 'Hello,\n\n', de: 'Guten Tag,\n\n' };
const BODY = {
  en: {
    security: 'Thank you for reporting this so quickly. We are treating it as a security incident and our on-call security team has been notified [c0]. As an immediate step, please disconnect affected devices from the network and do not pay any ransom or reply to the sender [c1]. A team member will contact you directly to coordinate next steps.',
    outage: 'Thank you for letting us know. We have escalated the outage to our on-call engineers [c0]. While we investigate, please restart the VPN client and tell us whether other users at your site are affected [c1]. We will update this ticket as soon as service is restored.',
    money: 'Thank you for contacting us, and we understand your frustration. Refund and compensation decisions are made by our billing team, so we have forwarded your request to them for review [c0]. We are not able to confirm a refund in this reply. You will hear back once the review is complete [c1].',
    legal: 'Thank you for your request. We have forwarded it to our data protection team, who handle requests of this kind [c0]. They will confirm the next steps with you directly [c1].',
    billing: 'Thank you for your message about your invoice. You can download all invoices under Account → Billing [c0]. If an amount or detail looks incorrect, reply with the invoice number and our billing team will review and reissue it [c1].',
    password: 'Thanks for reaching out. To reset your password, open the sign-in page and choose "Forgot password". A reset link will arrive by email and stays valid for 24 hours [c0]. If it does not arrive, check your spam folder or reply here and we will start a manual reset after verifying your account [c1].',
    feature: 'Thank you for the suggestion. We have logged it with our product team for review [c0]. We can\'t commit to a timeline, but we will update this ticket if it is planned [c1].',
    product: 'Thanks for the details. Please update to the latest version and restart the application, which resolved similar reports [c0]. If the problem continues, send us the app version and a screenshot of the error so we can investigate [c1].',
    general: 'Thank you for reaching out. We have received your request and a member of our team will look into it [c0]. If you can share more details, such as screenshots or the steps you took, that will help us respond faster [c1].',
  },
  de: {
    security: 'vielen Dank für Ihre schnelle Meldung. Wir behandeln den Vorfall als Sicherheitsvorfall und haben unser Bereitschaftsteam informiert [c0]. Bitte trennen Sie betroffene Geräte sofort vom Netzwerk und zahlen Sie kein Lösegeld [c1]. Ein Teammitglied meldet sich direkt bei Ihnen.',
    outage: 'vielen Dank für Ihre Meldung. Wir haben die Störung an unser Bereitschaftsteam eskaliert [c0]. Bitte starten Sie den VPN-Client neu und teilen Sie uns mit, ob weitere Nutzer an Ihrem Standort betroffen sind [c1]. Wir informieren Sie, sobald der Dienst wiederhergestellt ist.',
    money: 'vielen Dank für Ihre Nachricht. Über Erstattungen entscheidet unser Abrechnungsteam, an das wir Ihre Anfrage weitergeleitet haben [c0]. Eine Erstattung können wir in dieser Antwort nicht zusagen. Sie erhalten eine Rückmeldung, sobald die Prüfung abgeschlossen ist [c1].',
    legal: 'vielen Dank für Ihre Anfrage. Wir haben sie an unser Datenschutzteam weitergeleitet [c0]. Das Team stimmt die nächsten Schritte direkt mit Ihnen ab [c1].',
    billing: 'vielen Dank für Ihre Nachricht zu Ihrer Rechnung. Alle Rechnungen finden Sie im Kundenportal unter Konto → Abrechnung [c0]. Wenn ein Betrag nicht stimmt, senden Sie uns bitte die Rechnungsnummer, damit unser Abrechnungsteam ihn prüfen kann [c1].',
    password: 'vielen Dank für Ihre Anfrage. Um Ihr Passwort zurückzusetzen, öffnen Sie die Anmeldeseite und wählen Sie „Passwort vergessen“. Der Link kommt per E-Mail und ist 24 Stunden gültig [c0]. Falls keine E-Mail ankommt, prüfen Sie bitte Ihren Spam-Ordner oder antworten Sie hier [c1].',
    feature: 'vielen Dank für Ihren Vorschlag. Wir haben ihn an unser Produktteam weitergegeben [c0]. Einen Zeitplan können wir nicht zusagen, wir aktualisieren aber dieses Ticket, sobald es Neuigkeiten gibt [c1].',
    product: 'vielen Dank für die Details. Bitte aktualisieren Sie auf die neueste Version und starten Sie die Anwendung neu; das hat bei ähnlichen Meldungen geholfen [c0]. Falls das Problem weiterhin besteht, senden Sie uns bitte die Versionsnummer und einen Screenshot [c1].',
    general: 'vielen Dank für Ihre Nachricht. Wir haben Ihre Anfrage erhalten und ein Teammitglied kümmert sich darum [c0]. Weitere Details wie Screenshots helfen uns, schneller zu antworten [c1].',
  },
};
// Extractive replies quote exactly one precedent (contract v1, "Draft modes").
const FALLBACK = {
  en: 'Thank you for your message. A similar ticket was resolved as described in [c0]. An agent will review and complete this reply.',
  de: 'vielen Dank für Ihre Nachricht. Ein ähnliches Ticket wurde wie in [c0] beschrieben gelöst. Ein Mitarbeiter prüft und ergänzt diese Antwort.',
};

// Same wording as engine/app/generate/fallbacks.py: promises nothing and cites nothing.
const HOLDING = {
  en: 'Thank you for your message. We have received your request, and a specialist will review it and reply as soon as possible.',
  de: 'vielen Dank für Ihre Nachricht. Wir haben Ihre Anfrage erhalten; eine Fachkraft prüft sie und meldet sich so schnell wie möglich bei Ihnen.',
};

// First lines of the historical agent answers shown as precedents[].answer_snippet.
const ANSWERS = {
  security: 'We isolated the affected server, restored the files from the last clean backup and reset all admin credentials.',
  outage: 'The VPN concentrator had stopped accepting new sessions. We failed over to the standby node and all sites reconnected.',
  money: 'The billing team reviewed the account and replied with the outcome; no refund was promised in the first response.',
  legal: 'The request was forwarded to the data protection officer, who confirmed the deletion in writing within the legal deadline.',
  billing: 'Invoices are available under Account → Billing. We reissued the invoice with the corrected VAT number.',
  password: 'After verifying the account owner we triggered a manual password reset and the customer could sign in again.',
  feature: 'Logged with the product team as a feature request; the customer was told there is no committed timeline.',
  product: 'Updating to the latest version and clearing the local cache resolved the crash for this customer.',
  general: 'We answered the question and pointed the customer to the relevant help-centre article.',
};
const TAGS = {
  security: ['security', 'incident'], outage: ['vpn', 'network', 'outage'], money: ['refund', 'billing'], legal: ['gdpr', 'privacy'],
  billing: ['invoice', 'billing'], password: ['password', 'account'], feature: ['feature', 'product'], product: ['crash', 'update'], general: ['general'],
};

// ---------- gateway PII masking (mirrors backend/internal/pii; shared cases in its testdata/cases.json) ----------
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
const digitCount = (m) => m.replace(/\D/g, '').length;
// Card-style grouping: 4-4-4-4 (optionally a short fifth group) or Amex 4-6-5.
function cardShaped(m) {
  const l = m.split(/[ -]+/).filter(Boolean).map((g) => g.length);
  if (l.length === 3) return l[0] === 4 && l[1] === 6 && (l[2] === 5 || l[2] === 4);
  if (l.length === 4 || l.length === 5) return l[0] === 4 && l[1] === 4 && l[2] === 4 && l[3] === 4 && (l.length === 4 || l[4] <= 3);
  return false;
}
const PII_RULES = [
  { type: 'EMAIL', re: /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu },
  // Compact or 4-spaced, any letter case; real IBANs are mostly digits, which keeps "ab12 this that" text.
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/gi, keep: (m) => digitCount(m) < 10 },
  {
    type: 'CARD',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    // Luhn or card-style grouping; after "+" or with a leading 00 it is an international phone number.
    keep: (m, prev) => prev === '+' || m.startsWith('00') || (!luhn(m.replace(/\D/g, '')) && !cardShaped(m)),
  },
  {
    type: 'ACCOUNT',
    // Masks only the number after the label; the value needs a digit so "customer number is missing" stays.
    re: /\b(account\s*(?:number|no\.?|nr\.?|#)|customer\s*(?:number|no\.?|id|#)|contract\s*(?:number|no\.?)|kontonummer|konto-?nr\.?|kundennummern?|kunden-?nr\.?|kd\.?-?nr\.?|vertragsnummer|vertrags-?nr\.?)((?:\s+(?:is|ist|lautet|lautete|was|war))?\s*[:#]?\s*)([A-Z0-9][A-Z0-9-]{3,23}(?: \d[A-Z0-9-]{0,9}){0,6})\b/gi,
    group: 3,
    keep: (m) => !/\d/.test(m),
  },
  // IPv4, full IPv6, and compressed IPv6 with "::".
  { type: 'IP', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})\b/gi },
  {
    type: 'PHONE',
    re: /(?<![\w-])(?:\+\d{1,3}[ \t-]?(?:\(0\)[ \t]?)?)?\(?0?\d{2,5}\)?(?:[ \t]{0,2}\/[ \t]{0,2}|[ \t-])?\d{2,8}(?:[ \t-]\d{2,8}){0,4}(?![\w])/g,
    // Fewer than 7 digits (years, times) is not a phone, nor is a bare digit run like an order number.
    keep: (m) => digitCount(m) < 7 || (!/^[+(0]/.test(m) && !/[ \t\-/)]/.test(m)),
  },
];
// Plain spaces replace Unicode ones first, so "030 1234567" from a mail signature is caught.
const UNICODE_SPACES = /[  -   　]/g;

// One numbering per ticket ([EMAIL_1], [EMAIL_2], ...), shared by subject and body; a repeated value (any
// letter case) keeps its number. Same as pii.Masker in Go.
export function createMasker() {
  const numbers = {};
  const counts = {};
  const placeholder = (type, value) => {
    const key = value.toLowerCase();
    const byValue = (numbers[type] ??= new Map());
    if (!byValue.has(key)) byValue.set(key, byValue.size + 1);
    counts[type] = (counts[type] || 0) + 1;
    return `[${type}_${byValue.get(key)}]`;
  };
  return {
    mask(text) {
      let out = text.replace(UNICODE_SPACES, ' ');
      for (const { type, re, keep, group } of PII_RULES) {
        out = out.replace(re, (m, ...args) => {
          const groups = args.slice(0, -2);
          const offset = args[args.length - 2];
          const whole = args[args.length - 1];
          if (!group) return keep?.(m, whole[offset - 1] ?? '') ? m : placeholder(type, m);
          const value = groups[group - 1];
          if (keep?.(value)) return m;
          return groups.slice(0, group - 1).join('') + placeholder(type, value);
        });
      }
      return out;
    },
    entities: () => PII_RULES.filter((r) => counts[r.type]).map((r) => ({ type: r.type, count: counts[r.type] })),
  };
}

export function maskPII(text) {
  const m = createMasker();
  return { text: m.mask(text), entities: m.entities() };
}

// ---------- the pipeline ----------
/**
 * @param {{ticket_id?: string, subject: string, body: string, created_at?: string}} input
 * @param {{burst?: boolean, overrides?: object}} ctx
 */
export function analyze(input, ctx = {}) {
  const o = ctx.overrides || {};
  const r = mulberry32(hash(`${input.subject ?? ''}\n${input.body}`));
  const masker = createMasker();
  const subject = masker.mask(input.subject ?? '');
  const body = masker.mask(input.body);
  const text = `${subject}\n${body}`;

  // language
  const detected = detectLanguage(text);
  const language = { ...detected, supported: SUPPORTED.includes(detected.code) };
  const draftLang = language.supported ? language.code : 'en';

  // category + flags
  const hits = Object.fromEntries(Object.keys(KW).map((g) => [g, firstHit(g, text)]));
  const category = o.category || CATEGORY_ORDER.find((c) => hits[c]) || 'general';
  const p = PROFILE[category];

  // classify: each head's confidence is probs[label], as the contract requires
  const confBase = o.confidence ?? p.conf;
  const pHigh = round2(Math.min(0.98, Math.max(0.02, p.pHigh + between(r, -0.04, 0.04))));
  const priorityLabel = o.priority || (pHigh >= P_HIGH_THRESHOLD ? 'high' : p.priority);
  const k = 5;
  const typeLabel = o.type || p.type;
  const queueLabel = o.queue || p.queue;
  const typeProbs = spread(typeLabel, round2(Math.min(0.99, confBase + between(r, 0, 0.06))), TYPES);
  const queueProbs = spread(queueLabel, round2(Math.min(0.99, confBase + between(r, -0.05, 0.02))), queueOrder(queueLabel).slice(0, 5), 0.93);
  const priorityProbs = priorityLabel === 'high'
    ? { high: pHigh, ...splitRest(['medium', 'low'], 1 - pHigh) }
    : { high: pHigh, [priorityLabel]: round2((1 - pHigh) * 0.8), [priorityLabel === 'medium' ? 'low' : 'medium']: round2(1 - pHigh - round2((1 - pHigh) * 0.8)) };
  const strong = confBase >= 0.75;
  const classification = {
    type: { label: typeLabel, confidence: typeProbs[typeLabel], probs: typeProbs },
    queue: { label: queueLabel, confidence: queueProbs[queueLabel], probs: queueProbs, votes: strong ? 4 + Math.round(r()) : 2 + Math.round(r()), k },
    priority: { label: priorityLabel, confidence: priorityProbs[priorityLabel], probs: priorityProbs, p_high: pHigh },
  };

  // retrieve: level 1 routes to the top queue (or top two when unsure), level 2 searches inside them
  const top = Math.min(0.97, (o.similarity ?? p.sim) + between(r, -0.03, 0.03));
  // Tickets matching no known topic find nothing in the knowledge base, so the draft is a holding reply.
  const precedents = (category === 'general' ? [] : BANK[category]).map(([id, subj, lang], i) => ({
    ticket_id: id,
    similarity: round2(top - i * between(r, 0.03, 0.07)),
    language: lang,
    type: p.type,
    queue: p.queue,
    priority: p.priority,
    subject: subj,
    answer_snippet: i === 0 ? ANSWERS[category] : 'Resolved after the customer confirmed the suggested steps worked.',
    tags: TAGS[category],
  }));
  const top1 = precedents[0]?.similarity ?? 0;
  const route = routeQueues(queueLabel, classification.queue.confidence, top, top1);
  const retrieval = { route, top_similarity: top1, k };

  // gate
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, severity: REASONS[code].severity, detail });
  if (classification.type.label === 'Incident' && pHigh >= P_HIGH_THRESHOLD) add('HIGH_PRIORITY_INCIDENT', `P(high) = ${pHigh.toFixed(2)} ≥ threshold ${P_HIGH_THRESHOLD}`);
  if (hits.security) add('SECURITY_INCIDENT', `Matched “${hits.security}”`);
  const burst = ctx.burst && category === 'outage' ? joinBurst(queueLabel) : null;
  if (burst) add('ACTIVE_OUTAGE', `Joined burst cluster ${burst.cluster_id} (${burst.ticket_count} tickets)`);
  if (hits.legal) add('LEGAL_OR_COMPLIANCE', `Matched “${hits.legal}”`);
  if (hits.injection) add('PROMPT_INJECTION', `Matched “${hits.injection}”`);
  if (top1 < SIM_THRESHOLD) add('NO_PRECEDENT', precedents.length ? `Top-1 similarity ${top1.toFixed(2)} < ${SIM_THRESHOLD}` : 'No similar ticket in the knowledge base');
  const minConf = Math.min(classification.type.confidence, classification.queue.confidence, classification.priority.confidence);
  if (minConf < CONF_FLOOR) add('LOW_CONFIDENCE', `Calibrated confidence ${minConf.toFixed(2)} < floor ${CONF_FLOOR}`);
  if (hits.money) add('UNSUPPORTED_REQUEST', `Matched “${hits.money}” — no commitments in draft`);
  if (o.ungrounded) add('UNGROUNDED_DRAFT', 'Claim “within 2 business days” not found in cited precedents after retry');
  if (!language.supported) add('UNSUPPORTED_LANGUAGE', `Detected ${language.code.toUpperCase()} (${Math.round(language.confidence * 100)}%)`);
  if (o.degraded) add('ENGINE_DEGRADED', 'Gemini timed out after 8 s — extractive fallback used');

  const decision = reasons.some((x) => x.severity === 'P1') ? 'ESCALATE_ONCALL' : reasons.length ? 'HUMAN_REVIEW' : 'AUTO_DRAFT';

  // draft + validate
  const c0 = precedents[0]?.ticket_id;
  const c1 = precedents[1]?.ticket_id;
  const core = (o.degraded ? FALLBACK : BODY)[draftLang];
  const coreText = typeof core === 'string' ? core : core[category];
  let draftText = HELLO[draftLang] + coreText.replace('[c0]', `[${c0}]`).replace('[c1]', `[${c1}]`) + SIGN[draftLang];
  if (o.ungrounded) draftText = draftText.replace(SIGN[draftLang], ` We will resolve this within 2 business days.${SIGN[draftLang]}`);
  const holding = precedents.length === 0;
  if (holding) draftText = HELLO[draftLang] + HOLDING[draftLang] + SIGN[draftLang];
  const draft = {
    language: draftLang,
    text: draftText,
    citations: holding ? [] : o.degraded ? [c0] : [c0, c1],
    mode: holding ? 'holding' : o.degraded ? 'extractive' : 'generated',
    validation: o.ungrounded
      ? { passed: false, citations_ok: true, numbers_ok: false, language_ok: true, retries: 1, issues: ['“2 business days” is not supported by any cited precedent.'] }
      : { passed: true, citations_ok: true, numbers_ok: true, language_ok: true, retries: 0, issues: [] },
  };

  // latency (ms)
  const latency = {
    gateway: round1(between(r, 3, 9)),
    language: round1(between(r, 2, 6)),
    classify: round1(between(r, 12, 28)),
    retrieve: round1(between(r, 90, 180)),
    gate: round1(between(r, 1, 3)),
    draft: round1(o.degraded ? 8000 + between(r, 20, 60) : between(r, 650, 1750)),
    validate: round1(between(r, 14, 42)),
  };
  latency.total = round1(Object.values(latency).reduce((a, b) => a + b, 0) + 1);

  const createdAt = input.created_at || new Date().toISOString();
  return {
    contract_version: '1.0',
    request_id: input.request_id || `req_${hex(6)}`,
    ticket_id: input.ticket_id,
    subject,
    body,
    created_at: createdAt,
    processed_at: new Date(Math.max(Date.now(), Date.parse(createdAt))).toISOString(),
    language,
    pii: { masked: masker.entities() },
    classification,
    retrieval,
    precedents,
    gate: { decision, reasons },
    draft,
    burst,
    latency_ms: latency,
    warnings: o.degraded ? [{ stage: 'draft', code: 'LLM_TIMEOUT', message: 'The LLM did not answer within 8 s; the reply quotes the best precedent instead.' }] : [],
  };
}

const SUPPORTED = ['en', 'de'];
const TYPES = ['Incident', 'Request', 'Problem', 'Change'];

// Gives label its probability and spreads `mass` of the rest over the other keys, largest first.
function spread(label, p, keys, mass = 1) {
  const others = keys.filter((x) => x !== label);
  return { [label]: p, ...splitRest(others, Math.max(0, mass - p)) };
}
function splitRest(keys, rest) {
  const weights = keys.map((_, i) => 2 ** (keys.length - i));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = {};
  let left = round2(rest);
  keys.forEach((key, i) => {
    const v = i === keys.length - 1 ? left : round2((rest * weights[i]) / sum);
    out[key] = Math.max(0, round2(v));
    left = round2(left - out[key]);
  });
  return out;
}

// Level 1 of the hierarchical retrieval (root README): keep the top queue when it scores at least 0.80,
// else search the top two. route.queues holds the top 3 level-1 scores.
const RUNNER_UP = {
  'Service Outages and Maintenance': 'IT Support',
  'IT Support': 'Technical Support',
  'Billing and Payments': 'Customer Service',
  'Customer Service': 'General Inquiry',
  'Product Support': 'Technical Support',
  'Technical Support': 'Product Support',
  'General Inquiry': 'Customer Service',
};
function queueOrder(label) {
  const second = RUNNER_UP[label];
  return [label, ...(second ? [second] : []), ...QUEUES.filter((x) => x !== label && x !== second)];
}
function routeQueues(label, queueConf, top, top1) {
  const first = round2(0.6 * queueConf + 0.4 * top);
  const [, second, third] = queueOrder(label);
  const queues = [
    { queue: label, score: first },
    { queue: second, score: round2(first * 0.45) },
    { queue: third, score: round2(first * 0.12) },
  ];
  const fallback = top1 < SIM_THRESHOLD;
  const searched = first >= 0.8 ? [label] : [label, second];
  return { queues, searched: fallback ? [] : searched, fallback_global: fallback };
}

// Session-wide outage cluster for "Simulate outage", shaped like contract v1's burst object.
let burstState = null;
function joinBurst(queue) {
  const now = new Date().toISOString();
  burstState = burstState
    ? { ...burstState, ticket_count: burstState.ticket_count + 1, last_seen: now }
    : { cluster_id: 'BURST-VPN-SERVICE', queue, lead_term: 'vpn', ticket_count: 1, first_seen: now, last_seen: now };
  return { ...burstState };
}

const round1 = (x) => Math.round(x * 10) / 10;
const hex = (bytes) => Array.from({ length: bytes * 2 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

// ---------- fake transport ----------
const sleep = (n) => new Promise((res) => setTimeout(res, n));

export const mockApi = {
  async health() {
    await sleep(120);
    return { status: 'degraded', mode: 'mock', contract_version: '1.0', components: { gateway: 'stub', engine: 'stub', vector_db: 'stub' } };
  },
  async triage(input, { burst = false } = {}) {
    if (!input.body?.trim()) {
      const e = new Error('body: must be 1 to 10,000 characters and not only whitespace.');
      e.code = 'VALIDATION_ERROR';
      throw e;
    }
    await sleep(500 + Math.random() * 700);
    const id = input.ticket_id || `LIVE-${hex(4).toUpperCase()}`;
    return analyze({ ...input, ticket_id: id }, { burst });
  },
};
