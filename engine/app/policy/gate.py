"""
DA-06: Enterprise Escalation Policy Gate
Implements the official SentinelDesk escalation protocol:
- Any P1 reason  -> ESCALATE_ONCALL
- Else any P2 reason -> HUMAN_REVIEW
- No reasons     -> AUTO_DRAFT
All matching reasons and detailed trigger explanations are returned.
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any

from engine.app.policy.keywords import match_keywords
from engine.app.policy.burst import OutageBurstDetector, BurstCluster

class GateAction(str, Enum):
    ESCALATE_ONCALL = "ESCALATE_ONCALL"
    HUMAN_REVIEW = "HUMAN_REVIEW"
    AUTO_DRAFT = "AUTO_DRAFT"

class ReasonCode(str, Enum):
    # P1 Severity Codes
    HIGH_PRIORITY_INCIDENT = "HIGH_PRIORITY_INCIDENT"
    SECURITY_INCIDENT = "SECURITY_INCIDENT"
    ACTIVE_OUTAGE = "ACTIVE_OUTAGE"

    # P2 Severity Codes
    LEGAL_OR_COMPLIANCE = "LEGAL_OR_COMPLIANCE"
    PROMPT_INJECTION = "PROMPT_INJECTION"
    NO_PRECEDENT = "NO_PRECEDENT"
    LOW_CONFIDENCE = "LOW_CONFIDENCE"
    UNSUPPORTED_REQUEST = "UNSUPPORTED_REQUEST"
    UNGROUNDED_DRAFT = "UNGROUNDED_DRAFT"
    UNSUPPORTED_LANGUAGE = "UNSUPPORTED_LANGUAGE"
    ENGINE_DEGRADED = "ENGINE_DEGRADED"

P1_CODES = {
    ReasonCode.HIGH_PRIORITY_INCIDENT,
    ReasonCode.SECURITY_INCIDENT,
    ReasonCode.ACTIVE_OUTAGE
}

P2_CODES = {
    ReasonCode.LEGAL_OR_COMPLIANCE,
    ReasonCode.PROMPT_INJECTION,
    ReasonCode.NO_PRECEDENT,
    ReasonCode.LOW_CONFIDENCE,
    ReasonCode.UNSUPPORTED_REQUEST,
    ReasonCode.UNGROUNDED_DRAFT,
    ReasonCode.UNSUPPORTED_LANGUAGE,
    ReasonCode.ENGINE_DEGRADED
}

@dataclass
class GateResult:
    action: GateAction
    reasons: List[ReasonCode] = field(default_factory=list)
    explanations: List[str] = field(default_factory=list)
    matched_keywords: Dict[str, List[str]] = field(default_factory=dict)
    burst_cluster: Optional[BurstCluster] = None
    telemetry: Dict[str, Any] = field(default_factory=dict)

class EscalationGate:
    def __init__(
        self,
        high_priority_threshold: float = 0.38,
        confidence_floor: float = 0.42,
        precedent_similarity_threshold: float = 0.28,
        burst_detector: Optional[OutageBurstDetector] = None
    ):
        self.high_priority_threshold = high_priority_threshold
        self.confidence_floor = confidence_floor
        self.precedent_similarity_threshold = precedent_similarity_threshold
        self.burst_detector = burst_detector or OutageBurstDetector()

    def evaluate(
        self,
        ticket_id: str,
        text: str,
        detected_language: str,
        pred_type: str,
        pred_queue: str,
        prob_high_priority: float,
        overall_confidence: float,
        top_precedent_similarity: float,
        is_ungrounded: bool = False,
        engine_degraded: bool = False
    ) -> GateResult:
        reasons: List[ReasonCode] = []
        explanations: List[str] = []

        # 1. Check Keywords (Security, Injection, Legal, Financial)
        kw_matches = match_keywords(text)

        # Check Security Incident (P1)
        if "SECURITY_EN" in kw_matches or "SECURITY_DE" in kw_matches:
            reasons.append(ReasonCode.SECURITY_INCIDENT)
            hits = kw_matches.get("SECURITY_EN", []) + kw_matches.get("SECURITY_DE", [])
            explanations.append(f"Security/Ransomware/Breach indicator detected: {', '.join(hits)}")

        # Check Active Outage Burst (P1)
        burst_cluster = self.burst_detector.record_and_evaluate(ticket_id, text, pred_queue)
        if burst_cluster is not None:
            reasons.append(ReasonCode.ACTIVE_OUTAGE)
            explanations.append(
                f"Ticket correlated with active incident cluster '{burst_cluster.cluster_id}' "
                f"({burst_cluster.ticket_count} tickets in rolling window)"
            )

        # Check High Priority Incident (P1)
        if pred_type.lower() == "incident" and prob_high_priority >= self.high_priority_threshold:
            reasons.append(ReasonCode.HIGH_PRIORITY_INCIDENT)
            explanations.append(
                f"Type=Incident and P(High)={prob_high_priority:.1%} exceeds tuned recall threshold ({self.high_priority_threshold:.1%})"
            )

        # 2. Check P2 Codes
        # Prompt Injection
        if "PROMPT_INJECTION" in kw_matches:
            reasons.append(ReasonCode.PROMPT_INJECTION)
            explanations.append(f"Prompt injection pattern detected: {', '.join(kw_matches['PROMPT_INJECTION'])}")

        # Legal or Compliance
        if "LEGAL" in kw_matches:
            reasons.append(ReasonCode.LEGAL_OR_COMPLIANCE)
            explanations.append(f"Legal/GDPR/Lawsuit compliance terms detected: {', '.join(kw_matches['LEGAL'])}")

        # Unsupported Request (Refund / Money)
        if "UNSUPPORTED_REQUEST" in kw_matches:
            reasons.append(ReasonCode.UNSUPPORTED_REQUEST)
            explanations.append(f"Unsupported financial/SLA refund demand: {', '.join(kw_matches['UNSUPPORTED_REQUEST'])}")

        # Low Classifier Confidence
        if overall_confidence < self.confidence_floor:
            reasons.append(ReasonCode.LOW_CONFIDENCE)
            explanations.append(
                f"Calibrated confidence ({overall_confidence:.1%}) below floor ({self.confidence_floor:.1%})"
            )

        # No Precedent (Low Similarity)
        if top_precedent_similarity < self.precedent_similarity_threshold:
            reasons.append(ReasonCode.NO_PRECEDENT)
            explanations.append(
                f"Top-1 precedent similarity ({top_precedent_similarity:.1%}) below grounding threshold ({self.precedent_similarity_threshold:.1%})"
            )

        # Unsupported Language
        if detected_language.lower() not in {"en", "de"}:
            reasons.append(ReasonCode.UNSUPPORTED_LANGUAGE)
            explanations.append(f"Language '{detected_language}' is not English or German")

        # Ungrounded Draft Flag
        if is_ungrounded:
            reasons.append(ReasonCode.UNGROUNDED_DRAFT)
            explanations.append("Draft resolution failed citation or factual grounding verification")

        # Engine Degraded Flag
        if engine_degraded:
            reasons.append(ReasonCode.ENGINE_DEGRADED)
            explanations.append("Generative LLM service unavailable; fallback extractor invoked")

        # 3. Determine Overall Action
        has_p1 = any(r in P1_CODES for r in reasons)
        has_p2 = any(r in P2_CODES for r in reasons)

        if has_p1:
            action = GateAction.ESCALATE_ONCALL
        elif has_p2:
            action = GateAction.HUMAN_REVIEW
        else:
            action = GateAction.AUTO_DRAFT

        return GateResult(
            action=action,
            reasons=reasons,
            explanations=explanations,
            matched_keywords=kw_matches,
            burst_cluster=burst_cluster,
            telemetry={
                "ticket_id": ticket_id,
                "prob_high": prob_high_priority,
                "confidence": overall_confidence,
                "top_similarity": top_precedent_similarity,
                "has_p1": has_p1,
                "has_p2": has_p2
            }
        )
