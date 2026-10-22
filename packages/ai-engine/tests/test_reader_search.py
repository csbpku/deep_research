import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from ai_engine.reading import search
from ai_engine.contracts.reading import ReadingAnswer

XML = '<rss><channel><item><title>Official releases</title><link>https://example.org/releases</link><description>Release notes.</description></item><item><link>javascript:alert(1)</link></item><item><link>https://example.org/releases</link></item></channel></rss>'


@pytest.fixture(autouse=True)
def no_live_search(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search, 'query_provider', AsyncMock(return_value=[]))


def test_parse_excerpts_and_reject_entity_expansion() -> None:
    assert len(search.parse_results(XML)) == 1
    assert search.parse_results(XML)[0]['url'] == 'https://example.org/releases'
    with pytest.raises(ValueError):
        search.parse_results('<!DOCTYPE rss [<!ENTITY x "test">]><rss/>')


@pytest.mark.asyncio
async def test_skipped_plan_does_not_call_search(monkeypatch: pytest.MonkeyPatch) -> None:
    planner = AsyncMock(return_value=SimpleNamespace(text='{"query":""}'))
    monkeypatch.setattr(search, 'generate_text', planner)
    def unexpected_http(**kwargs):
        raise AssertionError('Original-only request must not search')
    monkeypatch.setattr(search.httpx, 'AsyncClient', unexpected_http)
    assert await search.search_reading('Explain this', 'Article', 'user', 'req') == {'status': 'skipped', 'sources': []}
    assert 'body' not in json.loads(planner.call_args.kwargs['user_prompt'])


@pytest.mark.asyncio
async def test_only_minimal_query_sent_to_fixed_search_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search, 'generate_text', AsyncMock(return_value=SimpleNamespace(text='{"query":"library release"}')))
    calls = []
    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(503) if request.url.host == 'search.brave.com' else httpx.Response(200, text=XML)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    monkeypatch.setattr(search.httpx, 'AsyncClient', lambda **kwargs: client)
    result = await search.search_reading('Is it maintained?', 'Library', 'private-user-id', 'req')
    assert result['status'] == 'searched'
    assert len(calls) == 1
    assert calls[0].url.host == 'www.bing.com'
    assert calls[0].url.params['q'] == 'library release'
    assert 'authorization' not in calls[0].headers
    assert 'private-user-id' not in str(calls[0].url)


@pytest.mark.asyncio
async def test_sensitive_query_is_not_transmitted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search, 'generate_text', AsyncMock(return_value=SimpleNamespace(text='{"query":"sk-privatecredential123"}')))
    with pytest.raises(ValueError, match='sensitive'):
        await search.search_reading('Check this', 'Library', 'user', 'req')


def test_contract_keeps_external_and_original_evidence_separate() -> None:
    answer = ReadingAnswer.model_validate({'answer': 'Current status [W1]. Original [1].', 'webSources': [{'title': 'Release', 'url': 'https://example.org/releases'}], 'searchStatus': 'searched', 'evidence': [{'quote': 'Original text'}]})
    assert answer.web_sources is not None
    assert answer.web_sources[0].url == 'https://example.org/releases'
    assert answer.evidence[0].quote == 'Original text'


def test_irrelevant_fallback_does_not_become_evidence() -> None:
    assert search.relevant_sources([{'title': 'Official dictionary', 'url': 'https://example.org', 'snippet': 'Definition of official'}], 'React official docs') == []


@pytest.mark.asyncio
async def test_client_disconnect_cancels_search_planning(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    from ai_engine.server.app import ReaderSearchBody, reader_search

    cancelled = asyncio.Event()
    async def waiting(*args):
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.set()
    monkeypatch.setattr(search, 'search_reading', waiting)
    request = SimpleNamespace(state=SimpleNamespace(request_id='disconnect'), is_disconnected=AsyncMock(return_value=True))
    with pytest.raises(asyncio.CancelledError):
        await reader_search(ReaderSearchBody(question='Latest React docs?'), request)
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_search_failure_returns_fallback_without_internal_details(monkeypatch: pytest.MonkeyPatch) -> None:
    from ai_engine.server.app import ReaderSearchBody, reader_search

    monkeypatch.setattr(search, 'search_reading', AsyncMock(side_effect=RuntimeError('private provider diagnostics')))
    request = SimpleNamespace(state=SimpleNamespace(request_id='fallback'), is_disconnected=AsyncMock(return_value=False))
    assert await reader_search(ReaderSearchBody(question='Latest docs?'), request) == {'status': 'unavailable', 'sources': []}
