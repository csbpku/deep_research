from __future__ import annotations

import pytest

from tests.run_personal_knowledge_index_task import _test_anythingllm_config, _test_database_url


def test_live_task_runner_accepts_only_the_approved_test_database(monkeypatch: pytest.MonkeyPatch) -> None:
    dsn = "postgresql://postgres:postgres@127.0.0.1:55432/deep_research_test"
    monkeypatch.setenv("TEST_DATABASE_URL", dsn)

    assert _test_database_url() == dsn


@pytest.mark.parametrize(
    "dsn",
    [
        "postgresql://postgres:postgres@example.com:55432/deep_research_test",
        "postgresql://postgres:postgres@127.0.0.1:5432/deep_research_test",
        "postgresql://postgres:postgres@127.0.0.1:55432/deep_research",
    ],
)
def test_live_task_runner_rejects_other_databases(dsn: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEST_DATABASE_URL", dsn)

    with pytest.raises(SystemExit, match="restricted"):
        _test_database_url()


def test_live_task_runner_accepts_only_explicit_loopback_anythingllm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TEST_ANYTHINGLLM_URL", "http://127.0.0.1:3002")
    monkeypatch.setenv("TEST_ANYTHINGLLM_API_KEY", "synthetic-secret")

    assert _test_anythingllm_config() == ("http://127.0.0.1:3002", "synthetic-secret")


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:3002",
        "http://example.test:3002",
        "http://127.0.0.1:3002/api/v1",
        "http://user@127.0.0.1:3002",
        "http://127.0.0.1",
    ],
)
def test_live_task_runner_rejects_non_loopback_or_ambiguous_endpoints(
    url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TEST_ANYTHINGLLM_URL", url)
    monkeypatch.setenv("TEST_ANYTHINGLLM_API_KEY", "synthetic-secret")

    with pytest.raises(SystemExit):
        _test_anythingllm_config()
