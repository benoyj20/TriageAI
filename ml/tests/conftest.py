import os
import sys
import tempfile
from pathlib import Path

# Must be set before `ml.config` is imported anywhere: artifacts go to a throwaway dir, embeddings are offline.
os.environ["ARTIFACTS_DIR"] = tempfile.mkdtemp(prefix="sentineldesk_test_")
os.environ["EMBED_BACKEND"] = "hash"
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
