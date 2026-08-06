"""LLM-free helpers shared by P1-D topic aggregation and proposal workers.

The metadata-tag vocabulary keeps the two workers consistent: a tag such as
``tier_deep_read`` or ``python`` is collection metadata, not a research topic.
The title-term helpers provide the lightweight lexical pre-clustering that lets
the proposal worker ask the model about a small, concrete candidate group
instead of dumping every summary into one giant prompt.
"""

from __future__ import annotations

import re
from typing import Any, TypedDict

_METADATA_TAG_PREFIXES = ("profile_", "tier_")
_METADATA_TAG_EXACT = frozenset({
    "github", "arxiv", "huggingface", "devto", "hackernews",
    "lobsters", "producthunt", "rss", "news", "trending", "must_read",
    "topic_search",
})

# 宽泛领域/语言不是“热点主题”。具体议题（mcp / rag / agent-evaluation）
# 仍可进入；语义聚类也不能绕过这道守门。
_NON_TOPIC_TAGS = frozenset({
    "ai", "artificial-intelligence", "artificialintelligence",
    "llm", "llms", "large-language-model", "large-language-models",
    "machine-learning", "machinelearning", "deep-learning", "deeplearning",
    "programming", "coding", "software-development", "webdev",
    "opensource", "open-source",
    "python", "typescript", "javascript", "java", "kotlin", "scala",
    "go", "golang", "rust", "ruby", "php", "swift", "c", "cpp",
    "csharp", "c-sharp", "dotnet", "shell", "bash", "node", "nodejs",
})

# 这些 tag 是内容大类而不是可跟进的具体议题。预聚类时把它们排在后面，
# 避免 `devops` / `testing` 这类大类抢占本应属于 `mcp` / `rag` 的小簇。
# 具体议题仍会通过标题词面（例如 harness / memory / kimi）进入候选。
_BROAD_TAG_CONCEPTS = frozenset({
    "devops", "testing", "architecture", "automation", "productivity",
    "security", "api", "aws", "cloud", "devtools", "tooling", "tutorial",
    "career", "startup", "saas", "discuss", "showdev", "learning",
    "datascience", "selfhosted", "cli", "debugging", "cybersecurity",
    "docker", "finops", "beginners", "repo_digest", "tracked", "vendor",
    "risk_suspected_repost",
})

_TITLE_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "for", "with", "from", "into", "to",
    "of", "in", "on", "at", "is", "are", "was", "were", "be", "been",
    "this", "that", "these", "those", "it", "its", "i", "we", "you",
    "your", "my", "me", "our", "us", "their", "them", "how", "why",
    "what", "when", "which", "who", "whom", "not", "no", "but", "as",
    "by", "up", "down", "out", "off", "over", "under", "again", "then",
    "once", "here", "there", "all", "any", "both", "each", "few", "more",
    "most", "other", "some", "such", "only", "own", "same", "so", "than",
    "too", "very", "can", "will", "just", "get", "got", "use", "using",
    "used", "build", "building", "make", "making", "new", "guide",
    "tutorial", "introduction", "intro", "introducing", "goes", "developers",
    "ai", "llm", "llms", "agent", "agents", "language", "model", "models",
    "machine", "learning", "deep", "neural", "network", "networks",
    "open", "source", "code", "coding", "programming", "software",
    "engineering", "developer", "development",
    "python", "typescript", "javascript", "java", "rust", "golang", "ruby",
    "php", "swift", "node", "nodejs", "react", "web", "app", "apps",
    "tool", "tools", "system", "systems", "data", "tech", "technology",
    "article", "blog", "week", "one", "built", "running",
})

_GENERIC_PHRASES = frozenset({
    "ai agent", "ai agents", "large language", "language model",
    "language models", "machine learning", "deep learning", "open source",
    "software development", "web development", "data science",
    "artificial intelligence",
})


class CandidateCluster(TypedDict):
    concept: str
    origin: str
    summary_ids: list[str]
    source_keys: list[str]
    rows: list[dict[str, Any]]


def is_metadata_tag(tag: str) -> bool:
    raw = tag.strip().lower()
    normalized = raw.replace("_", "-")
    return (
        raw.startswith(_METADATA_TAG_PREFIXES)
        or raw in _METADATA_TAG_EXACT
        or normalized in _NON_TOPIC_TAGS
    )


def title_concepts(title: str) -> set[str]:
    """Extract concrete title terms: CJK phrases, unigrams and bigrams."""
    if not title:
        return set()
    concepts: set[str] = set()
    lower = title.lower()
    concepts.update(re.findall(r"[\u4e00-\u9fff]{2,}", lower))
    normalized = re.sub(r"[^a-z0-9]+", " ", lower)
    tokens = [
        token
        for token in normalized.split()
        if len(token) >= 3 and token not in _TITLE_STOPWORDS
    ]
    concepts.update(tokens)
    concepts.update(
        f"{left} {right}"
        for left, right in zip(tokens, tokens[1:])
        if f"{left} {right}" not in _GENERIC_PHRASES
    )
    return concepts


def _normalized_tag(tag: str) -> str:
    return re.sub(r"\s+", "-", tag.strip().lower())


def _specificity(concept: str, origin: str) -> int:
    if origin == "tag" and concept not in _BROAD_TAG_CONCEPTS:
        return 3
    if origin == "title":
        return 2
    return 1


def build_candidate_clusters(
    rows: list[dict[str, Any]],
    *,
    min_summaries: int = 3,
    min_sources: int = 2,
    max_clusters: int = 6,
) -> list[CandidateCluster]:
    """Group summaries by shared title concepts and non-metadata tags.

    The model still decides whether a group is a real shared event/problem;
    this only replaces one giant 60-row prompt with a few focused prompts.
    """
    by_concept: dict[str, CandidateCluster] = {}
    for row in rows:
        row_id = str(row.get("id") or "")
        if not row_id:
            continue
        raw_tags = row.get("tags")
        tag_concepts: set[str] = set()
        if isinstance(raw_tags, list):
            tag_concepts = {
                _normalized_tag(str(tag))
                for tag in raw_tags
                if not is_metadata_tag(str(tag))
            }
        title_concept_set = title_concepts(str(row.get("title") or ""))
        for concept in tag_concepts | title_concept_set:
            cluster = by_concept.get(concept)
            if cluster is None:
                cluster = CandidateCluster(
                    concept=concept,
                    origin="title",
                    summary_ids=[],
                    source_keys=[],
                    rows=[],
                )
                by_concept[concept] = cluster
            if concept in tag_concepts:
                cluster["origin"] = "tag"
            if row_id in cluster["summary_ids"]:
                continue
            cluster["summary_ids"].append(row_id)
            cluster["source_keys"].append(str(row.get("sourceKey") or ""))
            cluster["rows"].append(row)

    clusters = [
        cluster
        for cluster in by_concept.values()
        if len(cluster["summary_ids"]) >= min_summaries
        and len(set(cluster["source_keys"])) >= min_sources
    ]
    clusters.sort(
        key=lambda cluster: (
            _specificity(cluster["concept"], cluster["origin"]),
            len(cluster["summary_ids"]),
            len(set(cluster["source_keys"])),
            cluster["concept"],
        ),
        reverse=True,
    )

    selected: list[CandidateCluster] = []
    covered_ids: set[str] = set()
    for cluster in clusters:
        ids = set(cluster["summary_ids"])
        if covered_ids and len(ids & covered_ids) / len(ids) >= 0.6:
            continue
        selected.append(cluster)
        covered_ids.update(ids)
        if len(selected) >= max_clusters:
            break
    return selected


__all__ = ["CandidateCluster", "build_candidate_clusters", "is_metadata_tag", "title_concepts"]
