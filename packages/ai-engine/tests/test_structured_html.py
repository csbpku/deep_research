from base64 import b64decode

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


def test_drops_missing_arxiv_image_src_without_using_page_url() -> None:
    html = """
    <article>
      <figure id="S5.F1">
        <img src="" class="ltx_missing ltx_missing_image" alt="Refer to caption">
        <figcaption>Figure 1: A figure unavailable in the HTML rendering.</figcaption>
      </figure>
      <p>正文足够长，确保这个节点被识别为文章正文。这里补充缺失图形的上下文，确认抽取器会保留图注而不会把页面地址误当图片地址。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html, "https://arxiv.org/html/2608.20280")

    assert "Figure 1: A figure unavailable in the HTML rendering." in markdown
    assert "![Refer to caption](https://arxiv.org/html/2608.20280)" not in markdown


def test_preserves_arxiv_inline_svg_figures_as_sanitized_images() -> None:
    html = """
    <article>
      <figure id="A1.F12">
        <svg class="ltx_picture" viewBox="0 0 20 20" onload="alert(1)">
          <path d="M0 0" style="fill:url(https://evil.example/x)"></path>
          <foreignObject style="font-size:10pt"><span class="ltx_text">推荐五款最值得</span></foreignObject>
          <foreignObject><span class="ltx_text">$16$ \\Delta \\times 2 \\to 72.9% \\tau \\blacksquare</span></foreignObject>
          <script>alert(1)</script>
        </svg>
        <figcaption>Figure 12: Pipeline overview.</figcaption>
      </figure>
      <p>正文足够长，确保这个节点被识别为文章正文。这里补充图形、章节和引用的上下文，确认结构化抽取不会丢失 arXiv 的内嵌矢量图。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html, "https://arxiv.org/html/2606.13610v2")
    data_url = next(
        part.split(")", 1)[0]
        for part in markdown.split("](")
        if part.startswith("data:image/svg+xml;base64,")
    )
    payload = b64decode(data_url.split("#", 1)[0].split(",", 1)[1]).decode("utf-8")

    assert "![图形](data:image/svg+xml;base64," in markdown
    assert "#A1.F12)" in markdown
    assert "Figure 12: Pipeline overview." in markdown
    assert 'xmlns="http://www.w3.org/2000/svg"' in payload
    assert 'viewBox="0 0 20 20"' in payload
    assert "font-size:7.20pt" in payload
    assert "推荐五款最值得买的 [产品]" in payload
    assert "$16$" not in payload
    assert "16 Δ × 2 → 72.9% τ ■" in payload
    assert 'xmlns="http://www.w3.org/1999/xhtml"' in payload
    assert "foreignObject" in payload
    assert "<script" not in payload
    assert "onload" not in payload
    assert "evil.example" not in payload


def test_extracts_abstract_text_from_arxiv_svg_foreign_object() -> None:
    html = """
    <article>
      <div class="ltx_para">
        <span>
          <svg class="ltx_picture">
            <foreignObject>
              <span class="ltx_p"><span class="ltx_text ltx_font_bold">Abstract</span></span>
              <span class="ltx_p"><span class="ltx_text">A paper abstract with <em>Random Attention</em> and <math alttext="32--43\\%">32--43%</math>.</span></span>
            </foreignObject>
          </svg>
        </span>
      </div>
      <h2>1 Introduction</h2>
      <p>正文足够长，确保抽取器会保留 SVG 摘要和后续章节，而不是把摘要只作为图片。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html, "https://arxiv.org/html/2609.03430")

    assert "## Abstract" in markdown
    assert "A paper abstract with *Random Attention* and $32--43\\%$." in markdown
    assert "![图形]" not in markdown


def test_preserves_arxiv_object_graphics_and_caption() -> None:
    html = """
    <article>
      <figure id="S1.F1" class="ltx_figure">
        <object type="image/svg+xml" data="2609.03430v1/fig_overview.svg" class="ltx_graphics"></object>
        <figcaption>Figure 1: Overview of the method.</figcaption>
      </figure>
      <p>正文足够长，确保抽取器会保留 object 图片、图注和文章正文。这里再补充一段上下文，避免测试文章根节点被误判为页面装饰。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html, "https://arxiv.org/html/2609.03430")

    assert "![图形](https://arxiv.org/html/2609.03430v1/fig_overview.svg#S1.F1)" in markdown
    assert "*Figure 1: Overview of the method.*" in markdown


def test_keeps_caption_when_arxiv_graphic_has_no_usable_source() -> None:
    html = """
    <article>
      <figure id="S1.F1" class="ltx_figure">
        <object type="image/svg+xml" data="" class="ltx_graphics"></object>
        <figcaption>Figure 1: The figure is unavailable in this rendering.</figcaption>
      </figure>
      <p>正文足够长，确保抽取器会保留不可用图片的上下文图注。这里再补充一段上下文，避免测试文章根节点被误判为页面装饰。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html, "https://arxiv.org/html/2609.03430")

    assert "*Figure 1: The figure is unavailable in this rendering.*" in markdown


def test_serializes_math_alttext_once_inside_tables() -> None:
    html = """
    <article>
      <table>
        <tr><th>Method</th><th>Score</th></tr>
        <tr><td>Random Attention</td><td><math alttext="32\\%">32<annotation>32\\%</annotation></math></td></tr>
      </table>
      <p>正文足够长，确保抽取器会保留表格和公式单元格。这里再补充一段上下文，避免测试文章根节点被误判为页面装饰。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html)

    assert "| Method | Score |" in markdown
    assert "| Random Attention | $32\\%$ |" in markdown
    assert "3232" not in markdown


def test_flattens_colspan_group_headers_without_corrupting_table_columns() -> None:
    html = """
    <article>
      <table>
        <tr><td></td><td colspan="2">Closed-Source</td><td colspan="2">Open-Weights</td></tr>
        <tr><td>Model</td><td>A</td><td>B</td><td>C</td><td>D</td></tr>
        <tr><td>Score</td><td>1</td><td>2</td><td>3</td><td>4</td></tr>
      </table>
      <p>正文足够长，确保这个节点被识别为文章正文。这里补充表格结构和分组表头的上下文，确认宽表抽取不会生成错误的空白列。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html)

    assert "*Closed-Source / Open-Weights*" in markdown
    assert "| Model | A | B | C | D |" in markdown
    assert "|  | Closed-Source | Open-Weights |  |  |" not in markdown


def test_preserves_arxiv_tables_inside_transformed_span_wrappers() -> None:
    html = """
    <article>
      <figure id="S4.T1" class="ltx_table">
        <figcaption>Table 1: Accuracy by model.</figcaption>
        <div class="ltx_inline-block ltx_transformed_outer">
          <span class="ltx_transformed_inner">
            <table class="ltx_tabular">
              <tr><th></th><th>MATH500</th><th>GPQA-D</th></tr>
              <tr><th></th><td>$K{=}1024$</td><td>$K{=}2048$</td></tr>
              <tr><th colspan="3">Qwen3-4B</th></tr>
              <tr><th>Full</th><td>0.939</td><td>0.562</td></tr>
            </table>
          </span>
        </div>
      </figure>
      <p>正文足够长，确保这个 arXiv 表格结构会被识别并保留为 Markdown，而不是被压平成连续文本。</p>
    </article>
    """

    markdown = structured_html_to_markdown(html)

    assert "|  | MATH500 | GPQA-D |" in markdown
    assert "| Full | 0.939 | 0.562 |" in markdown
    assert "MATH500\n\n$K{=}1024$" not in markdown
