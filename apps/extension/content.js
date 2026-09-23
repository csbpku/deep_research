(() => {
  if (window.__deepResearchReaderLoaded) {
    window.__deepResearchReaderRefresh?.();
    return;
  }
  window.__deepResearchReaderLoaded = true;

  const MIN_INLINE_IMAGE_CONFIDENCE = 0.75;
  const READING_BLOCK_SELECTOR = 'h1,h2,h3,h4,p,li,blockquote,pre,td,th,dt,dd';
  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'NAV', 'HEADER', 'FOOTER', 'ASIDE']);
  function findRoot() {
    const hostname = location.hostname.toLowerCase();
    if (hostname === 'github.com' || hostname.endsWith('.github.com') || hostname === 'github.localhost') {
      return document.querySelector('#readme, [data-testid="readme-container"], .markdown-body, article, main') || document.body;
    }
    if (hostname === 'zread.ai' || hostname.endsWith('.zread.ai') || hostname === 'zread.localhost') {
      return document.querySelector('article, [role="main"], main') || document.body;
    }
    return document.querySelector('article, main, [role="main"]') || document.body;
  }
  let root = findRoot();
  let lastSelectionContext = null;
  let lastSelectionNode = null;
  let lastSelectionRange = null;
  let toolbarHost = null;
  let readerDockHost = null;
  let readerStatusHost = null;
  const annotationHighlights = new Map();
  let refreshTimer = 0;
  let viewportTimer = 0;
  const blockIds = new WeakMap();
  const imageIds = new WeakMap();
  let nextBlockId = 0;
  let nextImageId = 0;
  window.__deepResearchReaderRefresh = () => {
    root = findRoot();
  };

  function clean(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function stableNodeId(node, kind, cache, sequence) {
    const existing = node.getAttribute(`data-deep-research-${kind}`) || cache.get(node);
    if (existing) {
      cache.set(node, existing);
      return existing;
    }
    const id = `${kind}-${sequence()}`;
    cache.set(node, id);
    node.setAttribute(`data-deep-research-${kind}`, id);
    return id;
  }

  function findQuoteRange(body, quote) {
    const directStart = body.indexOf(quote);
    if (directStart >= 0) return { start: directStart, end: directStart + quote.length };
    // Selection.toString() uses line breaks when a selection crosses block
    // elements, while the extracted quote is whitespace-normalized. Build a
    // normalized string with a map back to UTF-16 offsets so the server can
    // still verify the exact original body hash and slice.
    const normalizedChars = [];
    const offsets = [];
    let whitespace = false;
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      if (/\s/u.test(char)) {
        if (normalizedChars.length > 0 && !whitespace) {
          normalizedChars.push(' ');
          offsets.push(index);
        }
        whitespace = true;
        continue;
      }
      normalizedChars.push(char);
      offsets.push(index);
      whitespace = false;
    }
    while (normalizedChars[0] === ' ') {
      normalizedChars.shift();
      offsets.shift();
    }
    while (normalizedChars[normalizedChars.length - 1] === ' ') {
      normalizedChars.pop();
      offsets.pop();
    }
    const normalized = normalizedChars.join('');
    const normalizedStart = normalized.indexOf(clean(quote));
    if (normalizedStart < 0) return null;
    const normalizedEnd = normalizedStart + clean(quote).length - 1;
    return {
      start: offsets[normalizedStart],
      end: offsets[normalizedEnd] + 1,
    };
  }

  function sourceUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('deep-research-anchor');
    url.searchParams.delete('deep-research-source');
    url.searchParams.delete('deep-research-summary');
    url.searchParams.delete('deep-research-platform');
    if (url.hash.startsWith('#deep-research-anchor=')) url.hash = '';
    return url.toString();
  }

  function entryContext() {
    const params = new URL(location.href).searchParams;
    const source = params.get('deep-research-source') === 'radar' ? 'radar' : null;
    const summaryId = source ? params.get('deep-research-summary')?.slice(0, 160) || null : null;
    let platformUrl = null;
    if (source) {
      try {
        const candidate = new URL(params.get('deep-research-platform') || '');
        if (candidate.protocol === 'http:' || candidate.protocol === 'https:') {
          platformUrl = candidate.origin;
        }
      } catch {
        platformUrl = null;
      }
    }
    return { source, summaryId, platformUrl };
  }

  function hasExternalTranslation() {
    // Keep this allow-list narrow. Generic class names such as `translate`
    // occur in ordinary sites and would create false positives. These hooks
    // cover the common Immersive Translate DOM markers without inspecting
    // extension internals or page cookies.
    return Boolean(document.querySelector(
      '[data-immersive-translate], immersive-translate, [class^="immersive-translate"], [class*=" immersive-translate"], [id^="immersive-translate"]',
    ));
  }

  function pendingAnchor() {
    const queryValue = new URL(location.href).searchParams.get('deep-research-anchor');
    const fromHash = location.hash.startsWith('#deep-research-anchor=')
      ? location.hash.slice('#deep-research-anchor='.length)
      : '';
    const value = queryValue || fromHash;
    if (!value) return null;
    try {
      const parsed = JSON.parse(queryValue ? value : decodeURIComponent(value));
      return parsed && typeof parsed.quote === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  function extractBlocks() {
    const nodes = Array.from(root.querySelectorAll(READING_BLOCK_SELECTOR))
      .filter((node) => !node.closest('[data-deep-research-translation]'))
      // Never treat a form or an editable control as article text. This is a
      // privacy boundary for pages that mix documentation with a comment,
      // search, or password form.
      .filter((node) => !node.closest('form, [contenteditable="true"]'))
      .filter((node) => !ignored.has(node.tagName))
      // Prefer the inner paragraph/list item when a table cell contains a
      // structured block. This keeps one source passage from entering the
      // translation queue twice while still covering plain table cells.
      .filter((node) => !node.matches('td,th,dt,dd') || !node.querySelector('h1,h2,h3,h4,p,li,blockquote,pre'));
    const blocks = [];
    nodes.forEach((node) => {
      const text = clean(node.innerText || node.textContent || '');
      const minimumLength = node.matches('td,th,dt,dd') ? 4 : 20;
      if (text.length < minimumLength || text.length > 12000) return;
      const id = stableNodeId(node, 'block', blockIds, () => nextBlockId++);
      node.dataset.deepResearchBlock = id;
      blocks.push({ id, text, kind: node.matches('pre,code') ? 'code' : 'text' });
    });
    // Keep the complete bounded text map so a selection near the end of a
    // long document can still receive a strict offset/hash anchor. The page
    // payload is capped at 256 KiB below, while translation requests use only
    // the 24 blocks currently in or near the viewport.
    return blocks;
  }

  function readImageDataUrl(image) {
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(image.naturalWidth, 2400);
      canvas.height = Math.round(image.naturalHeight * (canvas.width / image.naturalWidth));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.88);
    } catch {
      // Cross-origin images without CORS cannot be read through canvas. Keep
      // their public URL so a vision provider that can fetch URLs may process it.
      return null;
    }
  }

  function hasExplicitStaticFrame(node) {
    return node?.getAttribute?.('data-deep-research-static-frame') === 'true'
      || node?.dataset?.deepResearchStaticFrame === 'true';
  }

  function isLikelyAnimatedImage(node) {
    if (!node || hasExplicitStaticFrame(node)) return false;
    const source = node.currentSrc || node.src || '';
    // The DOM does not expose whether a WebP/GIF is animated reliably.  Treat
    // formats that are conventionally animated as unsafe unless the page has
    // explicitly marked the currently displayed frame as static.  It is safer
    // to show a retryable boundary than to overwrite a moving diagram with a
    // translation of an arbitrary frame.
    return /^data:image\/(?:gif|apng)(?:;|,)/iu.test(source)
      || /\.(?:gif|apng)(?:[?#]|$)/iu.test(source);
  }

  function readSvgDataUrl(svg) {
    try {
      const markup = new XMLSerializer().serializeToString(svg);
      if (!markup || markup.length > 600_000) return null;
      return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(markup)))}`;
    } catch {
      return null;
    }
  }

  function rasterizeSvgDataUrl(dataUrl, width, height) {
    if (!dataUrl || !/^data:image\/svg(?:\+xml)?(?:;|,)/iu.test(dataUrl)) return Promise.resolve(dataUrl);
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        try {
          const sourceWidth = Math.max(1, Math.round(Number(width) || image.naturalWidth || image.width || 1));
          const sourceHeight = Math.max(1, Math.round(Number(height) || image.naturalHeight || image.height || 1));
          const scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(sourceWidth * scale));
          canvas.height = Math.max(1, Math.round(sourceHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) return resolve(dataUrl);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(dataUrl);
        }
      };
      image.onerror = () => resolve(dataUrl);
      image.src = dataUrl;
    });
  }

  function extractImages() {
    const imageNodes = [
      ...Array.from(root.querySelectorAll('img')),
      // Inline SVG is common in architecture diagrams and documentation. Do
      // not send tiny icons or the extension's own overlays to a model.
      ...Array.from(root.querySelectorAll('svg')).filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 80 && rect.height >= 40 && (node.viewBox?.baseVal?.width || rect.width) >= 80;
      }),
    ];
    const candidates = imageNodes.length;
    const images = imageNodes.slice(0, 40)
      .filter((node) => !node.closest('[data-deep-research-image-wrap],[data-deep-research-translation]'))
      .filter((node) => !node.closest('form, [contenteditable="true"]'))
      .filter((node) => node.getAttribute('aria-hidden') !== 'true')
      .slice(0, 40)
      .map((node) => {
        const id = stableNodeId(node, 'image', imageIds, () => nextImageId++);
        const isSvg = node.tagName.toLowerCase() === 'svg';
        const animated = !isSvg && isLikelyAnimatedImage(node);
        const svgText = isSvg
          ? Array.from(node.querySelectorAll('text, title, desc'))
            .map((item) => clean(item.textContent || ''))
            .filter(Boolean)
            .join('\n')
            .slice(0, 12_000)
          : '';
        // Do not rasterize or retain bytes for an animation until the user
        // explicitly confirms the currently displayed frame.
        const dataUrl = isSvg ? readSvgDataUrl(node) : animated ? null : readImageDataUrl(node);
        const rect = node.getBoundingClientRect();
        const width = isSvg
          ? Number(node.viewBox?.baseVal?.width) || Math.round(rect.width)
          : node.naturalWidth || node.width || 0;
        const height = isSvg
          ? Number(node.viewBox?.baseVal?.height) || Math.round(rect.height)
          : node.naturalHeight || node.height || 0;
        const modelScale = width && height ? Math.min(1, 2400 / Math.max(width, height)) : 1;
        const modelWidth = Math.max(1, Math.round(width * modelScale)) || 0;
        const modelHeight = Math.max(1, Math.round(height * modelScale)) || 0;
        const loaded = isSvg || (node.complete && Number(node.naturalWidth) > 0 && Number(node.naturalHeight) > 0);
        const src = isSvg ? '' : node.currentSrc || node.src || '';
        const sourceAvailable = Boolean(src || dataUrl);
        node.dataset.deepResearchImage = id;
        return {
          id,
          isSvg,
          svgText,
          // Keep the regular viewport payload small. Full-document requests
          // carry dataUrl explicitly; a data URL must never be echoed on the
          // scroll/progress path or placed in session storage.
          src: isSvg ? '' : node.currentSrc || node.src || '',
          dataUrl: dataUrl && dataUrl.length <= 600_000 ? dataUrl : null,
          alt: clean(node.alt || node.getAttribute('aria-label') || ''),
          width,
          height,
          // The model may receive a downscaled raster while the page overlay
          // remains anchored to the original image dimensions. The reader
          // core uses these fields to map OCR boxes back to source pixels.
          modelWidth: dataUrl ? modelWidth : width,
          modelHeight: dataUrl ? modelHeight : height,
          // Keep an image candidate even when an inline SVG is too large to
          // serialize and has no public URL. The worker can then surface an
          // explicit, retryable failure instead of silently claiming the
          // image was outside the translation scope.
          status: animated
            ? 'animated'
            : !sourceAvailable
            ? 'unreadable'
            : width === 0 || height === 0 || !loaded
            ? 'pending'
            : width > 20 && height > 20 ? 'ready' : 'unsupported',
          inputWarning: animated
            ? '动画图片只处理明确标记的静态帧；当前图片未自动覆盖。'
            : sourceAvailable ? '' : '图片没有可读取的数据或公开 URL；请允许图片访问后重试。',
        };
      })
      // Keep animated candidates so the side panel can report the explicit
      // boundary and let the user retry after providing a static frame.
      .filter((image) => image.status !== 'unsupported');
    return { items: images, candidates, truncated: candidates > images.length };
  }

  async function extractImagesForModel() {
    const imageData = extractImages();
    const items = await Promise.all(imageData.items.map(async (image) => {
      if (!image.dataUrl?.startsWith('data:image/svg+xml')) return image;
      const dataUrl = await rasterizeSvgDataUrl(image.dataUrl, image.width, image.height);
      const modelScale = image.width && image.height ? Math.min(1, 2400 / Math.max(image.width, image.height)) : 1;
      return {
        ...image,
        dataUrl,
        modelWidth: Math.max(1, Math.round(image.width * modelScale)),
        modelHeight: Math.max(1, Math.round(image.height * modelScale)),
      };
    }));
    return { ...imageData, items };
  }

  function visibleBlocks() {
    const blocks = extractBlocks();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const nearby = blocks.filter((block) => {
      const node = document.querySelector(`[data-deep-research-block="${CSS.escape(block.id)}"]`);
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.bottom >= -viewportHeight * 0.5 && rect.top <= viewportHeight * 1.5;
    });
    return (nearby.length > 0 ? nearby : blocks.slice(0, 8)).slice(0, 24);
  }

  function scopeWarningsFor(blocks, body) {
    const warnings = [];
    const readingRoot = document.querySelector('article, main, [role="main"]');
    if (!readingRoot && blocks.length < 2) {
      warnings.push('当前页面没有识别到稳定的正文容器；全文范围可能不完整，建议直接选择原文段落操作。');
    }
    if (!blocks.length && String(body || '').trim()) {
      warnings.push('当前页面正文尚未形成可处理的文本块；请等待页面加载或改用选段操作。');
    }
    const crossOriginFrames = Array.from(document.querySelectorAll('iframe')).filter((frame) => {
      try {
        const source = new URL(frame.getAttribute('src') || frame.src || '', location.href);
        return /^https?:$/u.test(source.protocol) && source.origin !== location.origin;
      } catch {
        return false;
      }
    });
    if (crossOriginFrames.length > 0) {
      warnings.push(`当前页面包含 ${crossOriginFrames.length} 个跨域 iframe；扩展只处理当前页面 DOM，iframe 内容需在其页面单独启用。`);
    }
    return warnings;
  }

  function pageContext() {
    window.__deepResearchReaderRefresh();
    const blocks = extractBlocks();
    const fullBody = blocks.map((block) => block.text).join('\n\n');
    const body = fullBody.slice(0, 256000);
    const translatedBlockIds = blocks
      .filter((block) => {
        const node = document.querySelector(`[data-deep-research-block="${CSS.escape(block.id)}"]`);
        return Boolean(node?.nextElementSibling?.hasAttribute('data-deep-research-translation'));
      })
      .map((block) => block.id);
    const translatedImageIds = Array.from(document.querySelectorAll('[data-deep-research-image]'))
      .filter((node) => node.closest('[data-deep-research-image-wrap]'))
      .map((node) => node.getAttribute('data-deep-research-image') || '')
      .filter(Boolean);
    let fallback = '';
    if (!body) {
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,form,[contenteditable="true"],nav,header,footer,aside').forEach((node) => node.remove());
      fallback = clean(clone.innerText || clone.textContent || '').slice(0, 256000);
    }
    const entry = entryContext();
    return {
      url: sourceUrl(),
      title: document.title || location.hostname,
      // The first version targets the team's default reading language. A
      // preference picker can be added without changing the page protocol.
      language: 'zh-CN',
      body: body || fallback,
      bodyCharCount: fullBody.length || fallback.length,
      bodyTruncated: fullBody.length > 256000,
      blockCount: blocks.length,
      blocks: blocks.slice(0, 24),
      scopeWarnings: scopeWarningsFor(blocks, body || fallback),
      // Keep public image URLs and bounded inline SVG data in viewport updates.
      // The latter lets a newly inserted diagram enter an already-running
      // translation queue without requiring a second full-page action. Raster
      // data URLs stay on the explicit full-document path to avoid filling
      // session storage with image bytes.
      images: extractImages().items
        .map(({ id, src, dataUrl, alt, width, height, modelWidth, modelHeight, status, inputWarning, isSvg, svgText }) => ({
          id, src, ...(dataUrl?.startsWith('data:image/svg+xml') ? { dataUrl } : {}), alt, width, height, modelWidth, modelHeight, status, inputWarning, isSvg, svgText,
        })),
      scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
      scrollHeight: Math.round(document.documentElement.scrollHeight || 0),
      translatedBlockIds,
      translatedImageIds,
      translationDetected: hasExternalTranslation(),
      entrySource: entry.source,
      entrySummaryId: entry.summaryId,
      entryPlatformUrl: entry.platformUrl,
    };
  }

  async function contextWithHash(context) {
    const digest = await contentHash(String(context.body || ''));
    return digest ? { ...context, contentHash: digest } : context;
  }

  function fullDocumentContext() {
    const context = pageContext();
    const allBlocks = extractBlocks();
    return extractImagesForModel().then((imageData) => ({
      ...context,
      blocks: allBlocks.slice(0, 160),
      blockCount: allBlocks.length,
      blocksTruncated: allBlocks.length > 160,
      images: imageData.items,
      translatedImageIds: context.translatedImageIds || [],
      imageCandidateCount: imageData.candidates,
      imageTruncated: imageData.truncated,
      full: true,
    }));
  }

  function sectionForSelection(selection) {
    const container = selection?.anchorNode?.parentElement?.closest('article, main, [role="main"]') || root;
    const anchorNode = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement || null;
    if (!anchorNode || !container) return '';
    const headings = Array.from(container.querySelectorAll('h1,h2,h3,h4'));
    let current = null;
    for (const heading of headings) {
      if (heading === anchorNode || heading.contains(anchorNode)) {
        current = heading;
        break;
      }
      const relation = heading.compareDocumentPosition(anchorNode);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) current = heading;
    }
    if (!current) return clean(anchorNode.innerText || anchorNode.textContent || '').slice(0, 80000);
    const level = Number(current.tagName.slice(1)) || 4;
    const parts = [];
    let node = current;
    while (node && parts.join('\n\n').length < 80000) {
      if (node.nodeType === Node.ELEMENT_NODE && !node.closest('[data-deep-research-translation]')) {
        const tag = node.tagName?.toLowerCase();
        if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
          const nextLevel = Number(tag.slice(1)) || 4;
          if (node !== current && nextLevel <= level) break;
        }
        if (['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'pre'].includes(tag)) {
          const text = clean(node.innerText || node.textContent || '');
          if (text.length >= 2) parts.push(text);
        }
      }
      node = node.nextElementSibling;
      if (!node && current.parentElement && current.parentElement !== container) {
        node = current.parentElement.nextElementSibling;
      }
    }
    return parts.join('\n\n').slice(0, 80000);
  }

  function sectionTitleForSelection(selection) {
    const container = selection?.anchorNode?.parentElement?.closest('article, main, [role="main"]') || root;
    const anchorNode = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement || null;
    if (!anchorNode || !container) return '';
    const headings = Array.from(container.querySelectorAll('h1,h2,h3,h4'));
    let current = null;
    for (const heading of headings) {
      if (heading === anchorNode || heading.contains(anchorNode)) {
        current = heading;
        break;
      }
      const relation = heading.compareDocumentPosition(anchorNode);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) current = heading;
    }
    return current ? clean(current.innerText || current.textContent || '').slice(0, 120) : '';
  }

  function selectorPathForSelection(selection) {
    let element = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    const parts = [];
    while (element instanceof Element && element !== document.body && parts.length < 8) {
      const tag = element.tagName.toLowerCase();
      if (element.id && /^[A-Za-z][\w:-]{0,80}$/u.test(element.id)) {
        parts.unshift(`${tag}#${CSS.escape(element.id)}`);
        break;
      }
      const siblings = element.parentElement ? Array.from(element.parentElement.children).filter((item) => item.tagName === element.tagName) : [];
      const position = siblings.indexOf(element) + 1;
      parts.unshift(`${tag}${position > 0 ? `:nth-of-type(${position})` : ''}`);
      element = element.parentElement;
    }
    return parts.join(' > ').slice(0, 1000);
  }

  async function contentHash(text) {
    try {
      if (!globalThis.crypto?.subtle) return undefined;
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return undefined;
    }
  }

  async function selectionContext() {
    const selection = window.getSelection();
    const quote = clean(selection?.toString() || '');
    if (!quote) return null;
    removeSelectionTranslation();
    const selectedElement = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    if (selectedElement?.closest?.('form, [contenteditable="true"]')) return null;
    const page = pageContext();
    const quoteRange = findQuoteRange(page.body, quote);
    const startOffset = quoteRange?.start;
    const endOffset = quoteRange?.end;
    const prefix = startOffset > 0 ? page.body.slice(Math.max(0, startOffset - 120), startOffset) : '';
    const suffix = endOffset !== undefined ? page.body.slice(endOffset, endOffset + 120) : '';
    const hash = await contentHash(page.body);
    if (hash) page.contentHash = hash;
    const selectorPath = selectorPathForSelection(selection);
    const selectionElement = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    lastSelectionNode = selectionElement?.closest?.(READING_BLOCK_SELECTOR) || null;
    // Keep a detached copy of the exact range. Opening the side panel moves
    // focus away from the page, but the selection translation still needs a
    // trustworthy place to display its short result. The range is validated
    // again when the result returns; a changed DOM never receives stale text.
    lastSelectionRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const anchor = { quote, prefix, suffix, ...(startOffset >= 0 ? { startOffset, endOffset } : {}), ...(hash ? { contentHash: hash } : {}), ...(selectorPath ? { selectorPath } : {}) };
    return {
      ...page,
      section: sectionForSelection(selection),
      sectionTitle: sectionTitleForSelection(selection),
      scope: 'selection',
      selection: anchor,
    };
  }

  function removeSelectionToolbar() {
    toolbarHost?.remove();
    toolbarHost = null;
  }

  function isTypingTarget(target) {
    return target instanceof HTMLElement && (
      target.matches('input, textarea, select, [contenteditable="true"]')
      || Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    );
  }

  // Keep the lightweight toolbar useful without forcing the reader to reach
  // for the mouse. These are page-local shortcuts and deliberately avoid
  // firing while a user is typing in a form or editor.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.querySelector('[data-deep-research-image-zoom]')) closeImageZoom();
      if (toolbarHost) removeSelectionToolbar();
      return;
    }
    if (isTypingTarget(event.target) || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    const shortcuts = { t: 'translate', e: 'explain', q: 'ask', s: 'summary', k: 'save', m: 'annotate' };
    const action = shortcuts[event.key.toLowerCase()];
    if (!action || !lastSelectionContext) return;
    event.preventDefault();
    send({ type: 'deep-research:selection', context: lastSelectionContext });
    send({ type: 'deep-research:selection-action', action });
    removeSelectionToolbar();
  }, true);

  function showSelectionToolbar(context) {
    removeSelectionToolbar();
    const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    if (!rect) return;
    toolbarHost = document.createElement('div');
    toolbarHost.dataset.deepResearchToolbar = 'true';
    toolbarHost.style.cssText = `position:fixed;z-index:2147483647;left:${Math.max(8, Math.min(window.innerWidth - 330, rect.left))}px;top:${Math.max(8, rect.top - 46)}px;`;
    const shadow = toolbarHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>:host{all:initial}div{display:flex;gap:4px;max-width:min(520px,calc(100vw - 16px));overflow-x:auto;padding:5px;border:1px solid #d9ddd5;border-radius:9px;background:#fff;box-shadow:0 5px 18px #20211f2e;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{border:0;border-radius:5px;background:#fff;color:#30332f;padding:5px 7px;cursor:pointer;white-space:nowrap}button:hover{background:#eff4ff;color:#315fe8}</style>
      <div role="toolbar" aria-label="Deep Research 阅读操作">
        <button data-action="summary" aria-keyshortcuts="Alt+Shift+S" title="Alt+Shift+S">总结这段</button><button data-action="explain" aria-keyshortcuts="Alt+Shift+E" title="Alt+Shift+E">解释这段</button><button data-action="translate" aria-keyshortcuts="Alt+Shift+T" title="Alt+Shift+T">翻译这段</button><button data-action="ask" aria-keyshortcuts="Alt+Shift+Q" title="Alt+Shift+Q">问这段</button><button data-action="save" aria-keyshortcuts="Alt+Shift+K" title="Alt+Shift+K">摘录</button><button data-action="annotate" aria-keyshortcuts="Alt+Shift+M" title="Alt+Shift+M">标注</button>
      </div>`;
    shadow.querySelectorAll('button').forEach((button) => {
      button.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        send({ type: 'deep-research:selection', context });
        send({ type: 'deep-research:selection-action', action });
        removeSelectionToolbar();
      });
    });
    document.documentElement.appendChild(toolbarHost);
  }

  function ensureReaderDock() {
    if (readerDockHost?.isConnected) return;
    readerDockHost = document.createElement('div');
    readerDockHost.dataset.deepResearchDock = 'true';
    readerDockHost.style.cssText = 'position:fixed;z-index:2147483645;right:10px;top:55%;transform:translateY(-50%);';
    const shadow = readerDockHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        .dock{display:grid;gap:5px;padding:4px;border:1px solid rgba(49,89,201,.22);border-radius:10px 3px 3px 10px;background:#fff;box-shadow:0 5px 18px rgba(23,34,53,.16)}
        button{position:relative;display:grid;width:44px;height:34px;place-items:center;border:0;border-radius:7px;background:#fff;color:#2445a8;cursor:pointer;font:800 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;transition:transform .16s ease,background .16s ease,border-color .16s ease}
        button[data-action="open"]{height:40px;border-top:1px solid #e2e7f0;border-radius:7px 3px 3px 7px}
        button:hover{transform:translateX(-2px);border-color:#6f8ee0;background:#eff4ff}
        button:focus-visible{outline:2px solid #3159c9;outline-offset:2px}
        button::after{content:attr(data-tooltip);position:absolute;right:calc(100% + 8px);top:50%;z-index:1;transform:translateY(-50%) translateX(4px);padding:5px 7px;border:1px solid #d9e0f1;border-radius:5px;background:#172235;color:#fff;box-shadow:0 4px 12px rgba(23,34,53,.18);font:700 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s ease,transform .12s ease}
        button:hover::after,button:focus-visible::after{opacity:1;transform:translateY(-50%) translateX(0)}
        .glyph{display:grid;width:24px;height:24px;place-items:center;border-radius:6px 6px 6px 2px;background:#172235;color:#fff;letter-spacing:0}
        .quick{font-size:10px;color:#3159c9}
        @media(prefers-reduced-motion:reduce){button{transition:none}}
      </style>
      <div class="dock" role="toolbar" aria-label="技术文章快捷入口">
        <button type="button" class="quick" data-action="summary" data-tooltip="总结本页" aria-label="Summary this page：总结本页" title="Summary this page：总结本页"><span aria-hidden="true">总结</span></button>
        <button type="button" class="quick" data-action="translate" data-tooltip="翻译本页" aria-label="Enable translation：翻译本页" title="Enable translation：翻译本页"><span aria-hidden="true">翻译</span></button>
        <button type="button" data-action="open" data-tooltip="打开聊天" aria-label="打开聊天" title="打开 Deep Research Reader 聊天侧栏"><span class="glyph">R</span></button>
      </div>`;
    shadow.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.action === 'summary') setReaderStatus('正在读取正文并生成全文总结…', 'loading');
      if (button.dataset.action === 'translate') setReaderStatus('正在读取正文，准备全文翻译…', 'loading');
      if (button.dataset.action === 'open') setReaderStatus('正在打开聊天侧栏…', 'loading');
      chrome.runtime.sendMessage({
        type: button.dataset.action === 'open' ? 'deep-research:open-panel' : 'deep-research:page-action',
        ...(button.dataset.action === 'open' ? {} : { action: button.dataset.action }),
      }).catch(() => {});
    }));
    document.documentElement.appendChild(readerDockHost);
  }

  function setReaderStatus(label, tone = 'loading', detail = '') {
    if (!readerStatusHost?.isConnected) {
      readerStatusHost = document.createElement('div');
      readerStatusHost.dataset.deepResearchStatus = 'true';
      readerStatusHost.style.cssText = 'position:fixed;z-index:2147483646;right:64px;top:55%;transform:translateY(-50%);pointer-events:none;';
      const shadow = readerStatusHost.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          :host{all:initial}
          .status{max-width:min(310px,calc(100vw - 96px));padding:8px 10px;border:1px solid #d9e0f1;border-radius:7px;background:#172235;color:#fff;box-shadow:0 5px 18px rgba(23,34,53,.2);font:700 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;transform:translateX(5px);transition:opacity .16s ease,transform .16s ease}
          .status.visible{opacity:1;transform:translateX(0)}
          .status.ready{background:#246546;border-color:#a9c2b4}
          .status.error{background:#8b3a2d;border-color:#e0b7b0}
          .detail{display:block;margin-top:2px;color:rgba(255,255,255,.78);font-weight:500;font-size:10px}
          @media(prefers-reduced-motion:reduce){.status{transition:none}}
        </style>
        <div class="status" role="status"><span class="label"></span><span class="detail"></span></div>`;
      readerStatusHost.__statusElement = shadow.querySelector('.status');
      document.documentElement.appendChild(readerStatusHost);
    }
    const status = readerStatusHost.__statusElement;
    if (!status) return;
    status.classList.remove('ready', 'error');
    if (tone === 'ready' || tone === 'error') status.classList.add(tone);
    status.querySelector('.label').textContent = label;
    status.querySelector('.detail').textContent = detail;
    status.classList.add('visible');
    window.clearTimeout(readerStatusHost.__hideTimer);
    if (tone !== 'loading') {
      readerStatusHost.__hideTimer = window.setTimeout(() => status.classList.remove('visible'), 2600);
    }
  }

  function send(payload) {
    chrome.runtime.sendMessage({ type: 'deep-research:from-page', payload }).catch(() => {});
  }

  async function sendPageContext() {
    const context = await contextWithHash(pageContext());
    send({ type: 'deep-research:page-context', context, blocks: visibleBlocks() });
  }

  async function sendFullDocument() {
    send({ type: 'deep-research:full-document', context: await contextWithHash(await fullDocumentContext()) });
  }

  function sendViewportBlocks() {
    send({ type: 'deep-research:viewport-blocks', blocks: visibleBlocks() });
  }

  function removeSelectionTranslation() {
    document.querySelectorAll('[data-deep-research-selection-translation]').forEach((node) => node.remove());
  }

  function applySelectionTranslation(text, sourceText = '') {
    const translation = clean(text);
    if (!translation || !lastSelectionRange || !lastSelectionRange.commonAncestorContainer?.isConnected) return false;
    const selected = clean(lastSelectionRange.toString());
    const expected = clean(sourceText);
    // Refuse to display a result after the selection changed. A containing
    // paragraph is not enough evidence for a partial selection because it may
    // contain several unrelated claims.
    if (!selected || (expected && selected !== expected)) return false;
    removeSelectionTranslation();
    const rect = lastSelectionRange.getBoundingClientRect();
    const fallbackRect = lastSelectionNode?.getBoundingClientRect?.() || rect;
    if (!fallbackRect || (!rect.width && !rect.height && !fallbackRect.width && !fallbackRect.height)) return false;
    const popup = document.createElement('div');
    popup.dataset.deepResearchSelectionTranslation = 'true';
    popup.textContent = translation;
    const left = Math.max(8, Math.min(window.innerWidth - 360, (rect.width || rect.left ? rect.left : fallbackRect.left)));
    const top = Math.max(8, (rect.height || rect.top ? rect.bottom : fallbackRect.bottom) + 8);
    popup.style.cssText = `position:fixed;z-index:2147483646;left:${left}px;top:${Math.min(window.innerHeight - 120, top)}px;max-width:min(360px,calc(100vw - 16px));padding:8px 10px;border:1px solid #b8c7f4;border-left:3px solid #315fe8;border-radius:6px;background:#f7f9ff;color:#172235;box-shadow:0 4px 16px rgba(23,34,53,.16);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap;pointer-events:auto;`;
    popup.setAttribute('role', 'status');
    popup.setAttribute('aria-label', '选段翻译');
    document.documentElement.appendChild(popup);
    return true;
  }

  function normalizedTextWithMap(value) {
    const chars = [];
    const offsets = [];
    let whitespace = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (/\s/u.test(char)) {
        if (chars.length > 0 && !whitespace) {
          chars.push(' ');
          offsets.push(index);
        }
        whitespace = true;
        continue;
      }
      chars.push(char);
      offsets.push(index);
      whitespace = false;
    }
    while (chars[0] === ' ') {
      chars.shift();
      offsets.shift();
    }
    while (chars.at(-1) === ' ') {
      chars.pop();
      offsets.pop();
    }
    return { text: chars.join(''), offsets };
  }

  function rangeForQuoteInElement(element, quote) {
    const textNodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let body = '';
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-deep-research-translation],[data-deep-research-annotation-highlight]')) continue;
      textNodes.push({ node, start: body.length });
      body += node.nodeValue || '';
    }
    let start = body.indexOf(quote);
    let end = start >= 0 ? start + quote.length : -1;
    if (start < 0) {
      const normalized = normalizedTextWithMap(body);
      const normalizedQuote = clean(quote);
      const normalizedStart = normalized.text.indexOf(normalizedQuote);
      if (normalizedStart < 0) return null;
      const normalizedEnd = normalizedStart + normalizedQuote.length - 1;
      start = normalized.offsets[normalizedStart];
      end = normalized.offsets[normalizedEnd] + 1;
    }
    if (start < 0 || end <= start) return null;
    const locate = (offset) => {
      for (const item of textNodes) {
        const length = item.node.nodeValue?.length || 0;
        const itemEnd = item.start + length;
        if (offset < itemEnd || offset === itemEnd) {
          return { node: item.node, offset: Math.max(0, Math.min(length, offset - item.start)) };
        }
      }
      const last = textNodes.at(-1);
      return last ? { node: last.node, offset: last.node.nodeValue?.length || 0 } : null;
    };
    const startPoint = locate(start);
    const endPoint = locate(end);
    if (!startPoint || !endPoint) return null;
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  }

  async function resolveAnchorRange(anchor) {
    window.__deepResearchReaderRefresh();
    const quote = clean(anchor?.quote || '');
    if (!quote) return { error: '原文摘录为空，无法定位' };
    if (anchor.contentHash) {
      const currentBody = pageContext().body;
      const currentHash = await contentHash(currentBody);
      if (!currentHash || currentHash !== anchor.contentHash) return { error: '原文已变化，无法准确定位' };
    }
    const nodes = Array.from(root.querySelectorAll(READING_BLOCK_SELECTOR))
      .filter((node) => !node.closest('[data-deep-research-translation]'))
      .filter((node) => !node.closest('form, [contenteditable="true"]'))
      .filter((node) => !node.matches('td,th,dt,dd') || !node.querySelector('h1,h2,h3,h4,p,li,blockquote,pre'));
    let candidates = nodes.filter((node) => clean(node.innerText || node.textContent || '').includes(quote));
    if (anchor.selectorPath) {
      try {
        const selected = document.querySelector(anchor.selectorPath);
        if (selected && candidates.includes(selected)) candidates = [selected];
      } catch {
        // A selector captured on a previous page version is only a hint.
      }
    }
    if (candidates.length > 1 && (anchor.prefix || anchor.suffix)) {
      const prefix = clean(anchor.prefix || '');
      const suffix = clean(anchor.suffix || '');
      const narrowed = candidates.filter((node) => {
        const text = clean(node.innerText || node.textContent || '');
        return (!prefix || text.includes(prefix.slice(-40))) && (!suffix || text.includes(suffix.slice(0, 40)));
      });
      if (narrowed.length > 0) candidates = narrowed;
    }
    if (candidates.length !== 1) {
      return { error: candidates.length === 0 ? '原文已变化，无法准确定位' : '原文存在多个可能位置，无法安全定位' };
    }
    const range = rangeForQuoteInElement(candidates[0], quote);
    if (!range) return { error: '原文存在多个可能位置，无法安全定位' };
    return { target: candidates[0], range };
  }

  async function focusAnchor(anchor) {
    const resolved = await resolveAnchorRange(anchor);
    if (resolved.error) {
      send({ type: 'deep-research:anchor-unresolved', reason: resolved.error });
      return;
    }
    const target = resolved.target;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const previousOutline = target.style.outline;
    const previousOffset = target.style.outlineOffset;
    target.style.outline = '2px solid #315fe8';
    target.style.outlineOffset = '3px';
    window.setTimeout(() => {
      target.style.outline = previousOutline;
      target.style.outlineOffset = previousOffset;
    }, 1800);
    send({ type: 'deep-research:anchor-resolved' });
  }

  function removeAnnotationHighlight(id) {
    const existing = annotationHighlights.get(id);
    if (!existing) return;
    window.removeEventListener('scroll', existing.update, true);
    window.removeEventListener('resize', existing.update, true);
    existing.host.remove();
    annotationHighlights.delete(id);
  }

  function clearAnnotationHighlights() {
    Array.from(annotationHighlights.keys()).forEach(removeAnnotationHighlight);
  }

  async function applyAnnotationHighlight(annotation) {
    if (!annotation?.id || !annotation.anchor?.quote) return false;
    removeAnnotationHighlight(annotation.id);
    const resolved = await resolveAnchorRange(annotation.anchor);
    if (resolved.error) {
      send({ type: 'deep-research:annotation-unresolved', id: annotation.id, reason: resolved.error });
      return false;
    }
    const host = document.createElement('span');
    host.dataset.deepResearchAnnotationHighlight = annotation.id;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;';
    const update = () => {
      host.textContent = '';
      Array.from(resolved.range.getClientRects()).forEach((rect) => {
        if (!rect.width || !rect.height) return;
        const mark = document.createElement('span');
        mark.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:rgba(255,213,72,.28);border-bottom:2px solid rgba(184,129,0,.68);border-radius:2px;`;
        host.appendChild(mark);
      });
    };
    document.documentElement.appendChild(host);
    annotationHighlights.set(annotation.id, { host, update });
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update, true);
    update();
    send({ type: 'deep-research:annotation-resolved', id: annotation.id });
    return true;
  }

  function closeImageZoom() {
    const host = document.querySelector('[data-deep-research-image-zoom]');
    if (!host) return;
    host.remove();
  }

  function showImageZoom(image) {
    closeImageZoom();
    const host = document.createElement('div');
    host.dataset.deepResearchImageZoom = 'true';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial} .backdrop{position:fixed;inset:0;display:grid;place-items:center;padding:28px;background:rgba(12,18,29,.84);cursor:zoom-out;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        .frame{position:relative;display:flex;max-width:min(94vw,1400px);max-height:92vh;align-items:center;justify-content:center;padding:10px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:#111923;box-shadow:0 20px 70px rgba(0,0,0,.4);cursor:default}
        .frame img,.frame svg{display:block;max-width:88vw;max-height:86vh;width:auto;height:auto;object-fit:contain}
        .close{position:absolute;right:8px;top:8px;width:28px;height:28px;border:1px solid rgba(255,255,255,.35);border-radius:50%;background:rgba(0,0,0,.5);color:#fff;font-size:18px;line-height:1;cursor:pointer}
        .hint{position:absolute;left:12px;bottom:8px;color:rgba(255,255,255,.7);font-size:11px}
      </style>
      <div class="backdrop" role="dialog" aria-label="放大查看原图"><div class="frame"><button class="close" type="button" aria-label="关闭">×</button><span class="hint">点击背景或按 Esc 关闭</span></div></div>`;
    const frame = shadow.querySelector('.frame');
    const clone = image.cloneNode(true);
    clone.removeAttribute('data-deep-research-image');
    clone.style.maxWidth = '88vw';
    clone.style.maxHeight = '86vh';
    clone.style.width = 'auto';
    clone.style.height = 'auto';
    frame.insertBefore(clone, frame.querySelector('.close'));
    shadow.querySelector('.close').addEventListener('click', closeImageZoom);
    shadow.querySelector('.backdrop').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeImageZoom();
    });
    document.documentElement.appendChild(host);
  }

  function addImageControls(wrapper, image, layer, fallback, sideLayer = null) {
    const control = document.createElement('span');
    control.dataset.deepResearchImageControl = 'true';
    control.style.cssText = 'position:absolute;top:6px;right:6px;z-index:3;line-height:normal;';
    const shadow = control.attachShadow({ mode: 'open' });
    const animated = isLikelyAnimatedImage(image);
    shadow.innerHTML = `
      <style>
        :host{all:initial} .controls{display:flex;gap:4px;padding:3px;border:1px solid rgba(255,255,255,.55);border-radius:6px;background:rgba(16,24,36,.82);box-shadow:0 2px 8px rgba(0,0,0,.22);font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        button{border:0;border-radius:4px;padding:4px 6px;background:transparent;color:#fff;cursor:pointer;white-space:nowrap}button:hover,button:focus-visible{background:rgba(255,255,255,.18);outline:0}
      </style><span class="controls" role="toolbar" aria-label="图片阅读操作"><button type="button" data-action="toggle">原图</button><button type="button" data-action="zoom">放大</button>${animated ? '<button type="button" data-action="static-frame">当前帧</button>' : ''}<button type="button" data-action="explain">解读</button></span>`;
    const toggle = shadow.querySelector('[data-action="toggle"]');
    let showingOriginal = false;
    toggle.addEventListener('click', () => {
      showingOriginal = !showingOriginal;
      if (layer) layer.style.display = showingOriginal ? 'none' : '';
      if (sideLayer) sideLayer.style.display = showingOriginal ? 'none' : '';
      if (fallback) fallback.style.display = showingOriginal ? 'none' : '';
      toggle.textContent = showingOriginal ? '译文' : '原图';
      toggle.setAttribute('aria-label', showingOriginal ? '显示译文' : '显示原图');
    });
    shadow.querySelector('[data-action="zoom"]').addEventListener('click', () => showImageZoom(image));
    shadow.querySelector('[data-action="static-frame"]')?.addEventListener('click', (event) => {
      image.setAttribute('data-deep-research-static-frame', 'true');
      event.currentTarget.textContent = '已标记';
      event.currentTarget.setAttribute('aria-label', '已标记当前帧，点击全文翻译后处理');
      // Re-snapshot the page so a running full-document task can enqueue this
      // now-explicit static frame.  The original animation remains untouched
      // until the user asks for the translation.
      send({ type: 'deep-research:request-page' });
    });
    shadow.querySelector('[data-action="explain"]').addEventListener('click', async () => {
      // Clicking a figure can leave the previous paragraph selected. Clear it
      // before emitting the image scope so the debounced selection observer
      // cannot arrive afterward and replace the image discussion context.
      window.getSelection()?.removeAllRanges();
      const isSvg = image.tagName?.toLowerCase() === 'svg';
      const width = Number(image.naturalWidth || image.width || image.getBoundingClientRect().width || 0);
      const height = Number(image.naturalHeight || image.height || image.getBoundingClientRect().height || 0);
      const rawDataUrl = isSvg ? readSvgDataUrl(image) : readImageDataUrl(image);
      const dataUrl = isSvg ? await rasterizeSvgDataUrl(rawDataUrl, width, height) : rawDataUrl;
      const modelScale = width && height ? Math.min(1, 2400 / Math.max(width, height)) : 1;
      send({
        type: 'deep-research:image-action',
        image: {
          id: image.dataset.deepResearchImage || '',
          src: isSvg ? '' : image.currentSrc || image.src || '',
          dataUrl: dataUrl && dataUrl.length <= 600_000 ? dataUrl : null,
          alt: clean(image.alt || image.getAttribute('aria-label') || ''),
          width,
          height,
          modelWidth: dataUrl ? Math.max(1, Math.round(width * modelScale)) : width,
          modelHeight: dataUrl ? Math.max(1, Math.round(height * modelScale)) : height,
          status: 'ready',
        },
      });
    });
    wrapper.appendChild(control);
  }

  function applyImageTranslation(imageId, regions, confidence = 0, fallbackText = '', fallbackRegions = []) {
    const image = document.querySelector(`[data-deep-research-image="${CSS.escape(imageId)}"]`);
    if (!image || !Array.isArray(regions)) return false;
    if (image.closest('[data-deep-research-image-wrap]')) return false;
    const width = image.tagName?.toLowerCase() === 'svg'
      ? Number(image.viewBox?.baseVal?.width) || image.getBoundingClientRect().width
      : image.naturalWidth || image.width;
    const height = image.tagName?.toLowerCase() === 'svg'
      ? Number(image.viewBox?.baseVal?.height) || image.getBoundingClientRect().height
      : image.naturalHeight || image.height;
    if (!width || !height) return false;

    // This is a final, DOM-side safety gate. Model-side layout checks cannot
    // see the actual rendered image or stale cached responses. A box that is
    // too large, out of bounds, or overlaps another box is moved to the
    // outside callout list so it can never hide unrelated source evidence.
    const inlineRegions = [];
    const unsafeRegions = [];
    const isSafeGeometry = (region) => {
      const x = Number(region?.x);
      const y = Number(region?.y);
      const regionWidth = Number(region?.width);
      const regionHeight = Number(region?.height);
      if (![x, y, regionWidth, regionHeight].every(Number.isFinite)
        || x < 0 || y < 0 || regionWidth <= 0 || regionHeight <= 0
        || x + regionWidth > width + 1 || y + regionHeight > height + 1) return false;
      const vertical = regionHeight >= 48 && regionHeight >= regionWidth * 2;
      // A normal label should occupy a small part of a diagram. Tall, narrow
      // axis labels are the one intentional exception.
      if (vertical) {
        if (regionWidth > width * 0.14 || regionHeight > height * 0.82) return false;
      } else if (regionWidth > width * 0.45 || regionHeight > height * 0.30
        || regionWidth * regionHeight > width * height * 0.12) return false;
      const translation = String(region.translation || '').trim().replace(/\s+/gu, '');
      if (!translation) return false;
      if (translation.length > 96) return false;
      return true;
    };
    regions.forEach((region) => (isSafeGeometry(region) ? inlineRegions : unsafeRegions).push(region));
    const overlapping = new Set();
    const area = (region) => Math.max(1, Number(region.width) * Number(region.height));
    for (let index = 0; index < inlineRegions.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < inlineRegions.length; otherIndex += 1) {
        const left = inlineRegions[index];
        const right = inlineRegions[otherIndex];
        const intersectionWidth = Math.max(0, Math.min(Number(left.x) + Number(left.width), Number(right.x) + Number(right.width)) - Math.max(Number(left.x), Number(right.x)));
        const intersectionHeight = Math.max(0, Math.min(Number(left.y) + Number(left.height), Number(right.y) + Number(right.height)) - Math.max(Number(left.y), Number(right.y)));
        if ((intersectionWidth * intersectionHeight) / Math.min(area(left), area(right)) >= 0.12) {
          overlapping.add(left);
          overlapping.add(right);
        }
      }
    }
    const safeInlineRegions = inlineRegions.filter((region) => !overlapping.has(region));
    unsafeRegions.push(...inlineRegions.filter((region) => overlapping.has(region)));
    // Treat a wrong overlay as worse than a missing overlay: it can hide
    // arrows, numbers, and the source labels. Keep this in sync with
    // Keep this threshold in sync with reader-core.js. A wrong overlay is
    // worse than a missing overlay because it can hide source evidence.
    const hasReliableRegions = safeInlineRegions.length > 0 && confidence >= MIN_INLINE_IMAGE_CONFIDENCE;
    const positionedFallbacks = (Array.isArray(fallbackRegions)
      ? fallbackRegions.filter((region) => region && region.translation && [region.x, region.y, region.width, region.height].every(Number.isFinite)).slice(0, 24)
      : []).concat(unsafeRegions.filter((region) => region && region.translation));
    const uniqueFallbacks = [];
    const fallbackKeys = new Set();
    positionedFallbacks.forEach((region) => {
      const key = [region.x, region.y, region.width, region.height, region.translation].join('|');
      if (fallbackKeys.has(key)) return;
      fallbackKeys.add(key);
      uniqueFallbacks.push(region);
    });
    uniqueFallbacks.sort((left, right) => (Number(left.y) - Number(right.y)) || (Number(left.x) - Number(right.x)));
    // A region-level fallback is anchored to its OCR box. Only show the
    // unanchored whole-image note when the model could not provide any usable
    // coordinates; otherwise the same text would be duplicated below the
    // image and lose its relationship to the source label.
    const cleanedFallback = String(fallbackText || '').split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => !/^(?:原文|译文|翻译|translation)\s*[:：]?\s*$/iu.test(line))
      .join('\n').trim().slice(0, 12_000);
    const safeFallback = uniqueFallbacks.length ? '' : cleanedFallback;
    if (!hasReliableRegions && !safeFallback && !uniqueFallbacks.length) return false;
    const wrapper = document.createElement('span');
    wrapper.dataset.deepResearchImageWrap = imageId;
    wrapper.style.cssText = 'position:relative;display:inline-block;max-width:100%;line-height:0;vertical-align:middle;overflow:visible;';
    image.parentElement?.insertBefore(wrapper, image);
    wrapper.appendChild(image);
    image.style.maxWidth = '100%';
    image.style.height = 'auto';
    const renderedWidth = image.getBoundingClientRect().width || width;
    const renderScale = renderedWidth / width;
    let layer = null;
    if (hasReliableRegions) {
      layer = document.createElement('span');
      layer.dataset.deepResearchImageOverlay = imageId;
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
      safeInlineRegions.forEach((region) => {
        const x = Number(region.x);
        const y = Number(region.y);
        const regionWidth = Number(region.width);
        const regionHeight = Number(region.height);
        if (![x, y, regionWidth, regionHeight].every(Number.isFinite) || !region.translation) return;
        const label = document.createElement('span');
        label.textContent = String(region.translation);
        // OCR coordinates are in source-image pixels. Scale the CSS font to the
        // rendered image so a 2x retina diagram does not get giant overlays.
        // Narrow, tall boxes are usually chart axis labels. Use vertical
        // writing there so a reliable translation stays on the axis instead
        // of being detached into a misleading right-hand list.
        const verticalLabel = regionHeight >= 48 && regionHeight >= regionWidth * 2;
        const fontSize = verticalLabel
          ? Math.max(8, Math.min(18, regionWidth * 0.8 * renderScale))
          : Math.max(8, Math.min(24, regionHeight * 0.5 * renderScale));
        // Opaque fill is intentional: a translucent box leaves source glyphs
        // visible underneath and can create a false bilingual reading. The
        // original image remains one click away through the image control.
        label.style.cssText = `position:absolute;left:${(x / width) * 100}%;top:${(y / height) * 100}%;width:${(regionWidth / width) * 100}%;min-height:${(regionHeight / height) * 100}%;padding:1px 2px;box-sizing:border-box;background:#fff;color:#10141a;font:600 ${fontSize}px/1.12 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:normal;overflow:hidden;word-break:break-word;${verticalLabel ? 'writing-mode:vertical-rl;text-orientation:mixed;' : ''}`;
        layer.appendChild(label);
      });
      if (!layer.childElementCount) layer = null;
    }
    let sideLayer = null;
    if (uniqueFallbacks.length) {
      sideLayer = document.createElement('span');
      sideLayer.dataset.deepResearchImageSideTranslations = imageId;
      sideLayer.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;overflow:visible;';
      const sideWidth = Math.min(280, Math.max(150, renderedWidth * 0.34));
      const renderedHeight = image.getBoundingClientRect().height || height * renderScale;
      const imageRect = image.getBoundingClientRect();
      // A translation beside an OCR box must be outside the source image.
      // Measuring blank pixels inside the image as available "side" space
      // would let low-confidence labels cover unrelated diagram content.
      const viewportRightSpace = Math.max(0, window.innerWidth - imageRect.right);
      const viewportLeftSpace = Math.max(0, imageRect.left);
      const canPlaceRight = viewportRightSpace >= sideWidth + 10;
      const canPlaceLeft = !canPlaceRight && viewportLeftSpace >= sideWidth + 10;
      const sidePlacements = { right: [], left: [] };
      let belowImageHeight = 0;
      const estimatedLabelHeight = (text, source = '') => {
        const sourceText = String(source || '').trim().replace(/\s+/gu, ' ');
        const sideText = sourceText
          ? `原文：${sourceText.slice(0, 120)}\n译文：${String(text || '').trim()}`
          : String(text || '').trim();
        return Math.min(180, Math.max(42, 28 + (Math.ceil(sideText.length / 24) * 16)));
      };
      const nonOverlappingTop = (requestedTop, labelHeight, placements) => {
        let top = Math.max(0, requestedTop);
        for (const placement of placements) {
          if (top + labelHeight + 6 <= placement.top || top >= placement.bottom + 6) continue;
          top = placement.bottom + 6;
        }
        placements.push({ top, bottom: top + labelHeight });
        return top;
      };
      uniqueFallbacks.forEach((region) => {
        const x = Number(region.x) * renderScale;
        const y = Number(region.y) * renderScale;
        const labelHeight = estimatedLabelHeight(region.translation, region.text);
        let left;
        let top = y;
        let placement;
        if (canPlaceRight) {
          left = renderedWidth + 8;
          top = nonOverlappingTop(y, labelHeight, sidePlacements.right);
          placement = 'right';
        } else if (canPlaceLeft) {
          left = -sideWidth - 8;
          top = nonOverlappingTop(y, labelHeight, sidePlacements.left);
          placement = 'left';
        } else {
          left = Math.max(0, Math.min(renderedWidth - sideWidth, x));
          // No external gutter is available. Put the label below the image,
          // never back over source pixels, and reserve its actual height.
          top = renderedHeight + 8 + belowImageHeight;
          belowImageHeight += labelHeight + 6;
          placement = 'below';
        }
        const label = document.createElement('span');
        const sourceText = String(region.text || '').trim().replace(/\s+/gu, ' ');
        const translatedText = String(region.translation || '').trim();
        if (!translatedText) return;
        // A side translation must remain understandable when several labels
        // share the same external gutter. Keep the source quote with its
        // translation instead of presenting an unanchored list of Chinese
        // fragments that could be mistaken for page text.
        label.dataset.deepResearchImageSideTranslation = 'true';
        label.dataset.deepResearchImageSidePlacement = placement;
        const sourceLine = sourceText ? document.createElement('span') : null;
        if (sourceLine) {
          sourceLine.textContent = `原文  ${sourceText.slice(0, 120)}`;
          sourceLine.style.cssText = 'display:block;margin-bottom:3px;color:#806a3d;font:500 10px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
          label.appendChild(sourceLine);
        }
        const translationLine = document.createElement('span');
        translationLine.textContent = translatedText;
        translationLine.style.cssText = 'display:block;color:#3f321c;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
        label.appendChild(translationLine);
        const sideText = sourceText ? `原文 ${sourceText.slice(0, 120)}\n${translatedText}` : translatedText;
        const sideHeight = Math.min(180, Math.max(42, 28 + (Math.ceil(sideText.length / 24) * 16)));
        label.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${sideWidth}px;min-height:${sideHeight}px;box-sizing:border-box;padding:6px 8px;border:1px solid #d19a38;border-radius:5px;background:rgba(255,249,226,.98);color:#60491d;white-space:normal;overflow-wrap:anywhere;box-shadow:0 2px 6px rgba(72,48,12,.16);`;
        sideLayer.appendChild(label);
      });
      if (belowImageHeight) {
        // Absolute labels do not affect layout. Reserve bounded space so a
        // following paragraph cannot overlap the anchored fallback notes.
        wrapper.style.paddingBottom = `${Math.min(640, belowImageHeight + 8)}px`;
      }
      if (!sideLayer.childElementCount) sideLayer = null;
    }
    if (!layer && !sideLayer && !safeFallback) {
      wrapper.parentElement?.insertBefore(image, wrapper);
      wrapper.remove();
      return false;
    }
    if (layer) wrapper.appendChild(layer);
    if (sideLayer) wrapper.appendChild(sideLayer);
    let fallback = null;
    if (safeFallback) {
      fallback = document.createElement('div');
      fallback.dataset.deepResearchImageFallback = imageId;
      fallback.textContent = `旁侧译文：${safeFallback}`;
      fallback.style.cssText = 'position:relative;z-index:2;margin-top:6px;padding:7px 9px;border-left:3px solid #d19a38;background:#fff6df;color:#6b5125;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap;';
      wrapper.appendChild(fallback);
    }
    addImageControls(wrapper, image, layer, fallback, sideLayer);
    return true;
  }

  function restoreImageTranslations() {
    closeImageZoom();
    document.querySelectorAll('[data-deep-research-image-wrap]').forEach((wrapper) => {
      // Inline SVGs are first-class image candidates. Reinsert the original
      // node before removing the wrapper; otherwise restoring a translation
      // would silently delete the diagram from the page.
      const image = wrapper.querySelector('img,svg');
      if (image) {
        image.style.maxWidth = '';
        image.style.height = '';
        wrapper.parentElement?.insertBefore(image, wrapper);
      }
      wrapper.remove();
    });
    document.querySelectorAll('[data-deep-research-image-overlay]').forEach((node) => node.remove());
  }

  document.addEventListener('mouseup', () => {
    window.setTimeout(async () => {
      const context = await selectionContext();
      if (context) {
        lastSelectionContext = context;
        send({ type: 'deep-research:selection', context });
        showSelectionToolbar(context);
      }
    }, 0);
  }, true);

  document.addEventListener('selectionchange', () => {
    if (!window.getSelection()?.toString().trim()) {
      lastSelectionContext = null;
      lastSelectionRange = null;
      if (!toolbarHost?.matches(':hover')) removeSelectionToolbar();
    }
  }, true);

  window.addEventListener('scroll', () => {
    if (viewportTimer) return;
    viewportTimer = window.setTimeout(() => {
      viewportTimer = 0;
      sendViewportBlocks();
      send({ type: 'deep-research:reading-progress', progress: { url: sourceUrl(), scrollY: Math.round(window.scrollY || 0), scrollHeight: Math.round(document.documentElement.scrollHeight || 0) } });
    }, 250);
  }, { passive: true });

  const observer = new MutationObserver((records) => {
    const pageChanged = records.some((record) => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target?.closest('[data-deep-research-translation],[data-deep-research-selection-translation],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status],[data-deep-research-image-control],[data-deep-research-image-zoom],[data-deep-research-annotation-highlight]')) return false;
      if (record.type === 'childList' && record.removedNodes.length > 0 && Array.from(record.removedNodes).every((node) => node instanceof Element && node.matches('[data-deep-research-translation],[data-deep-research-selection-translation],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status],[data-deep-research-image-control],[data-deep-research-image-zoom],[data-deep-research-annotation-highlight]'))) return false;
      return record.type === 'childList' && (Array.from(record.addedNodes).some((node) => {
        return !(node instanceof Element && node.closest('[data-deep-research-translation],[data-deep-research-selection-translation],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status],[data-deep-research-image-control],[data-deep-research-image-zoom]'));
      }) || record.removedNodes.length > 0) || record.type === 'characterData';
    });
    if (!pageChanged) return;
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      window.__deepResearchReaderRefresh();
      clearAnnotationHighlights();
      removeSelectionTranslation();
      // A page update invalidates a position based anchor. Ask the panel to
      // display fresh content rather than silently reusing old evidence.
      lastSelectionContext = null;
      lastSelectionNode = null;
      sendPageContext();
    }, 400);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  for (const eventName of ['popstate', 'hashchange']) {
    window.addEventListener(eventName, () => {
      lastSelectionContext = null;
      lastSelectionNode = null;
      window.__deepResearchReaderRefresh();
      sendPageContext();
    });
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      window.setTimeout(() => {
        lastSelectionContext = null;
        lastSelectionNode = null;
        window.__deepResearchReaderRefresh();
        sendPageContext();
      }, 0);
      return result;
    };
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'deep-research:reader-status') {
      const tone = message.state === 'ready' ? 'ready' : message.state === 'error' ? 'error' : 'loading';
      setReaderStatus(String(message.label || '正在读取正文'), tone, String(message.detail || ''));
    }
    if (message?.type === 'deep-research:request-page') {
      sendPageContext();
    }
    if (message?.type === 'deep-research:mark-static-frame' && message.imageId) {
      const image = document.querySelector(`[data-deep-research-image="${CSS.escape(String(message.imageId))}"]`);
      if (image) {
        image.setAttribute('data-deep-research-static-frame', 'true');
        // Re-snapshot the page so the side panel sees this as a ready image,
        // while leaving the original frame untouched until translation runs.
        sendPageContext();
      }
    }
    if (message?.type === 'deep-research:request-full-document') {
      sendFullDocument();
    }
    if (message?.type === 'deep-research:focus-anchor' && message.anchor?.quote) {
      void focusAnchor(message.anchor);
    }
    if (message?.type === 'deep-research:apply-annotation' && message.annotation) {
      void applyAnnotationHighlight(message.annotation);
    }
    if (message?.type === 'deep-research:apply-annotations' && Array.isArray(message.annotations)) {
      clearAnnotationHighlights();
      message.annotations.forEach((annotation) => { void applyAnnotationHighlight(annotation); });
    }
    if (message?.type === 'deep-research:clear-annotations') {
      clearAnnotationHighlights();
    }
    if (message?.type === 'deep-research:restore-progress') {
      const scrollY = Number(message.scrollY);
      if (Number.isFinite(scrollY) && scrollY > 0) window.scrollTo({ top: Math.max(0, scrollY), behavior: 'auto' });
      if (message.anchor?.quote) window.setTimeout(() => void focusAnchor(message.anchor), 180);
    }
    if (message?.type === 'deep-research:apply-translations') {
      const translations = Array.isArray(message.translations) ? message.translations : [];
      let appliedCount = 0;
      translations.forEach(({ id, text, sourceText }) => {
        if (id === 'selection') {
          if (applySelectionTranslation(text, sourceText)) appliedCount += 1;
          return;
        }
        const node = id === 'selection' && lastSelectionNode?.isConnected
          ? lastSelectionNode
          : document.querySelector(`[data-deep-research-block="${CSS.escape(id)}"]`);
        if (!node || !text || node.nextElementSibling?.hasAttribute('data-deep-research-translation')) return;
        // DOM updates can reorder block ids between the request and the
        // response. Refuse to attach a translation to a different paragraph;
        // the user can retry after the viewport context is refreshed.
        if (typeof sourceText === 'string' && clean(node.innerText || node.textContent || '') !== clean(sourceText)) return;
        const translated = document.createElement('div');
        translated.dataset.deepResearchTranslation = 'true';
        translated.textContent = text;
        translated.style.cssText = 'margin:0.45em 0 1em;padding:0.55em 0.7em;border-left:3px solid #315fe8;background:#eff4ff;color:#30332f;font:inherit;line-height:1.65;';
        node.insertAdjacentElement('afterend', translated);
        appliedCount += 1;
      });
      send({ type: 'deep-research:translations-applied', count: appliedCount });
    }
    if (message?.type === 'deep-research:apply-image-translations') {
      const translations = Array.isArray(message.translations) ? message.translations : [];
      let appliedCount = 0;
      translations.forEach((translation) => {
        if (applyImageTranslation(translation.id, translation.regions, translation.confidence, translation.fallbackText, translation.fallbackRegions)) appliedCount += 1;
      });
      send({ type: 'deep-research:image-translations-applied', count: appliedCount });
    }
    if (message?.type === 'deep-research:restore-translations') {
      document.querySelectorAll('[data-deep-research-translation]').forEach((node) => node.remove());
      removeSelectionTranslation();
      restoreImageTranslations();
      send({ type: 'deep-research:translations-restored' });
    }
  });

  // Research-library links can carry a safe, opt-in fragment. It is handled
  // only after the content root exists, and an ambiguous/stale match fails
  // visibly instead of highlighting a merely similar paragraph.
  const initialAnchor = pendingAnchor();
  if (initialAnchor) {
    let attempts = 0;
    const retryInitialAnchor = () => {
      attempts += 1;
      void focusAnchor(initialAnchor);
      if (attempts < 4) window.setTimeout(retryInitialAnchor, attempts * 700);
    };
    window.setTimeout(retryInitialAnchor, 250);
  }
  ensureReaderDock();
})();
