// Domain vocabulary shared by every view.
// Gate codes and severities mirror the "Escalation gate" table in the root README.
// PROVISIONAL until contract v1 (H-02) is frozen — keep field names in one place here.

export const DECISIONS = {
  ESCALATE_ONCALL: { label: 'Escalate · On-call', short: 'Escalated', method: 'Escalated to on-call', tone: 'critical' },
  HUMAN_REVIEW: { label: 'Human review', short: 'Review', method: 'Held for human review', tone: 'warning' },
  AUTO_DRAFT: { label: 'Auto-draft', short: 'Auto-draft', method: 'Auto-drafted', tone: 'good' },
};

export const REASONS = {
  HIGH_PRIORITY_INCIDENT: { severity: 'P1', label: 'High-priority incident', hint: 'Type is Incident and P(high) is above the recall-tuned threshold' },
  SECURITY_INCIDENT: { severity: 'P1', label: 'Security incident', hint: 'Breach, ransomware or hacked terms (EN/DE)' },
  ACTIVE_OUTAGE: { severity: 'P1', label: 'Active outage', hint: 'Ticket joins an active burst cluster' },
  LEGAL_OR_COMPLIANCE: { severity: 'P2', label: 'Legal / compliance', hint: 'Lawyer, lawsuit, GDPR/DSGVO, deletion requests' },
  PROMPT_INJECTION: { severity: 'P2', label: 'Prompt injection', hint: 'Injection patterns in subject or body' },
  NO_PRECEDENT: { severity: 'P2', label: 'No precedent', hint: 'Top-1 similarity below threshold' },
  LOW_CONFIDENCE: { severity: 'P2', label: 'Low confidence', hint: 'Calibrated confidence below floor' },
  UNSUPPORTED_REQUEST: { severity: 'P2', label: 'Unsupported request', hint: 'Refund, compensation, pricing or contract terms' },
  UNGROUNDED_DRAFT: { severity: 'P2', label: 'Ungrounded draft', hint: 'Validator still fails after one retry' },
  UNSUPPORTED_LANGUAGE: { severity: 'P2', label: 'Unsupported language', hint: 'Language is not English or German' },
  ENGINE_DEGRADED: { severity: 'P2', label: 'Engine degraded', hint: 'LLM failed; extractive fallback used' },
};

// Mirrors the thresholds the live engine applies (engine/app/stages_live.py apply_thresholds and
// engine/app/policy/gate.py, DA-06). Change them there first.
export const GATE_THRESHOLDS = {
  highPriority: 0.26, // HIGH_PRIORITY_INCIDENT when Type=Incident and P(high) >= this (tuned priority_high_threshold)
  confidenceFloor: 0.42, // LOW_CONFIDENCE below this
  precedentSimilarity: 0.35, // NO_PRECEDENT when top-1 similarity is below this (no_precedent_threshold)
};

export const PRIORITIES = {
  high: { label: 'High', rank: 3 },
  medium: { label: 'Medium', rank: 2 },
  low: { label: 'Low', rank: 1 },
};

export const LANGUAGES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  unknown: 'Unknown',
};

// Operator workflow — drives the Kanban columns. The engine sets the starting column
// from the gate decision; operators move cards from there.
export const WORKFLOW = [
  { id: 'new', label: 'Incoming', short: 'Incoming', hint: 'Waiting for triage' },
  { id: 'escalated', label: 'Escalated · On-call', short: 'Escalated', hint: 'P1 reasons fired' },
  { id: 'review', label: 'Human review', short: 'Review', hint: 'P2 reasons fired' },
  { id: 'drafted', label: 'Draft ready', short: 'Draft ready', hint: 'Grounded draft, no reasons' },
  { id: 'resolved', label: 'Resolved', short: 'Resolved', hint: 'Reply sent or closed' },
];

export const STATUS_FROM_DECISION = {
  ESCALATE_ONCALL: 'escalated',
  HUMAN_REVIEW: 'review',
  AUTO_DRAFT: 'drafted',
};

export const PIPELINE_STAGES = [
  { id: 'gateway', label: 'Gateway' },
  { id: 'language', label: 'Language' },
  { id: 'classify', label: 'Classify' },
  { id: 'retrieve', label: 'Retrieve' },
  { id: 'gate', label: 'Gate' },
  { id: 'draft', label: 'Draft' },
  { id: 'validate', label: 'Validate' },
];

export const QUEUES = [
  'Technical Support',
  'Product Support',
  'Customer Service',
  'IT Support',
  'Billing and Payments',
  'Returns and Exchanges',
  'Service Outages and Maintenance',
  'Sales and Pre-Sales',
  'Human Resources',
  'General Inquiry',
];

export const TYPES = ['Incident', 'Request', 'Problem', 'Change'];
