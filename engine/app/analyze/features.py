"""TF-IDF featuriser. Lives in engine/ (not ml/) so the pickled model loads without the training package."""
from __future__ import annotations

from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer


class WordChar:
    """Word 1-2gram + char_wb 3-5gram TF-IDF as one transformer."""

    def __init__(self, max_word: int = 200_000, max_char: int = 300_000):
        self.w = TfidfVectorizer(ngram_range=(1, 2), min_df=2, max_features=max_word, sublinear_tf=True)
        self.c = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, max_features=max_char,
                                 sublinear_tf=True)

    def fit(self, texts):
        self.w.fit(texts)
        self.c.fit(texts)
        return self

    def transform(self, texts):
        return hstack([self.w.transform(texts), self.c.transform(texts)]).tocsr()
