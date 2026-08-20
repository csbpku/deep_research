from ai_engine.radar.structured_html import structured_html_to_markdown


def test_prefers_article_body_and_keeps_document_structure() -> None:
    html = """
    <html><body>
      <nav>noise</nav>
      <main><div class="blog-content">
        <h1>Article</h1>
        <h2>Table of Contents</h2><ul><li><a href="#real">Real</a></li></ul>
        <p>Intro with <a href="https://example.com">a link</a>.</p>
        <h2 id="real">Real section</h2>
        <details><summary><b>fast-plaid</b></summary><p>Implementation details.</p></details>
        <ul><li>One</li><li>Two</li></ul>
        <table><tr><th>Name</th><th>Score</th></tr><tr><td>A</td><td>1</td></tr></table>
        <pre><code class="language-python">print('ok')</code></pre>
      </div></main>
    </body></html>
    """

    markdown = structured_html_to_markdown(html)

    assert "## Real section" in markdown
    assert "Table of Contents" not in markdown
    assert "**fast-plaid**" in markdown
    assert "### fast-plaid" not in markdown
    assert "- One" in markdown
    assert "| Name | Score |" in markdown
    assert "~~~python" in markdown
    assert "[a link](https://example.com)" in markdown


def test_returns_empty_for_pages_without_an_article_root() -> None:
    assert structured_html_to_markdown("<html><body><nav>Only nav</nav></body></html>") == ""


def test_preserves_safe_article_images_with_absolute_urls() -> None:
    html = """
    <article>
      <figure><img src="/media/diagram.png" alt="系统架构图"><figcaption>架构</figcaption></figure>
      <img src="data:image/png;base64,broken" alt="不应保留">
      <p>正文足够长，确保这个节点被识别为文章正文而不是页面装饰。这里再补充一段技术说明，描述系统如何通过采集、处理和展示流程把原始内容还原成可阅读的文章，并覆盖数据来源、章节结构、引用位置、图片资源和阅读动作等信息。</p>
    </article>
    """
    markdown = structured_html_to_markdown(html, "https://example.com/posts/one")
    assert "![系统架构图](https://example.com/media/diagram.png)" in markdown
    assert "不应保留" not in markdown
