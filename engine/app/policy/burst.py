"""
DA-08: Outage Burst Detector (Bonus Feature)
Detects a sudden spike of correlated NEW tickets arriving close together in time,
raising the ACTIVE_OUTAGE (P1) flag.

Only live incoming tickets count, and only while they are inside the rolling window
(default 5 minutes). Historical knowledge-base tickets are never counted, and nothing is
persisted: the window lives in memory and is emptied as tickets age out.

Rules:
- A burst needs at least `burst_threshold` DISTINCT tickets sharing an outage term
  inside the window. Re-sending the same text counts once.
- Grouping is by outage term only (an outage reaches several queues), not by queue.
- Demo traffic (the console's "Simulate outage" button, deploy warm-ups) runs through a
  separate detector instance in the pipeline, so it can never trip a real outage.
"""

import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import List, Optional, Dict

DEFAULT_WINDOW_SECONDS = 300
DEFAULT_BURST_THRESHOLD = 3


@dataclass
class TicketEvent:
    ticket_id: str
    text: str
    queue: str
    timestamp: float = field(default_factory=time.time)
    matched_keywords: List[str] = field(default_factory=list)
    fingerprint: str = ""


@dataclass
class BurstCluster:
    cluster_id: str
    queue: str
    lead_term: str
    ticket_ids: List[str]
    first_seen: float
    last_seen: float
    ticket_count: int


def _fingerprint(text: str) -> str:
    """Normalised text, so the same ticket sent twice is counted once."""
    return re.sub(r"\s+", " ", text.lower()).strip()


class OutageBurstDetector:
    def __init__(self, window_seconds: int = DEFAULT_WINDOW_SECONDS, burst_threshold: int = DEFAULT_BURST_THRESHOLD):
        """
        :param window_seconds: Rolling time window over incoming tickets (default: 5 minutes).
        :param burst_threshold: Distinct correlated tickets needed to raise ACTIVE_OUTAGE.
        """
        self.window_seconds = window_seconds
        self.burst_threshold = burst_threshold
        self.events: deque[TicketEvent] = deque()
        self.active_clusters: Dict[str, BurstCluster] = {}

        # Outage signature terms that cluster together
        self.outage_signatures = [
            "vpn", "gateway", "outage", "timeout", "server down", "datenbank",
            "ausfall", "504", "502", "telemedicine", "hospital", "login failure"
        ]

    def _purge_expired(self, current_time: float):
        cutoff = current_time - self.window_seconds
        while self.events and self.events[0].timestamp < cutoff:
            self.events.popleft()
        for cid in [c for c, cl in self.active_clusters.items() if cl.last_seen < cutoff]:
            del self.active_clusters[cid]

    def record_and_evaluate(self, ticket_id: str, text: str, queue: str, now: Optional[float] = None) -> Optional[BurstCluster]:
        now = time.time() if now is None else now
        self._purge_expired(now)

        text_lower = text.lower()
        matched = [sig for sig in self.outage_signatures if sig in text_lower]
        fp = _fingerprint(text)

        # The same text re-sent inside the window is one ticket, not a new arrival.
        if not any(e.fingerprint == fp for e in self.events):
            self.events.append(TicketEvent(ticket_id=ticket_id, text=text, queue=queue, timestamp=now,
                                           matched_keywords=matched, fingerprint=fp))

        if not matched:
            return None

        for sig in matched:
            related = [e for e in self.events if sig in e.matched_keywords]
            if len(related) >= self.burst_threshold:
                cluster_id = f"BURST-{sig.upper().replace(' ', '_')}-{queue.split()[0].upper()}"
                cluster = BurstCluster(
                    cluster_id=cluster_id,
                    queue=queue,
                    lead_term=sig,
                    ticket_ids=[e.ticket_id for e in related],
                    first_seen=related[0].timestamp,
                    last_seen=related[-1].timestamp,
                    ticket_count=len(related)
                )
                self.active_clusters[cluster_id] = cluster
                return cluster

        return None

    def get_active_outage_banner(self) -> Optional[Dict]:
        self._purge_expired(time.time())
        if not self.active_clusters:
            return None
        # Return most critical/largest cluster
        top_cluster = max(self.active_clusters.values(), key=lambda c: c.ticket_count)
        return {
            "cluster_id": top_cluster.cluster_id,
            "headline": f"P1 ACTIVE OUTAGE: Correlated {top_cluster.lead_term.upper()} Failure",
            "impacted_queue": top_cluster.queue,
            "ticket_count": top_cluster.ticket_count,
            "tickets": top_cluster.ticket_ids
        }
