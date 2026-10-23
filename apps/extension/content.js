(() => {
  if (window.__deepResearchReaderLoaded) {
    window.__deepResearchReaderRefresh?.();
    return;
  }
  window.__deepResearchReaderLoaded = true;

  // Filled from design-system/tokens.json by scripts/sync-static.mjs. Keeping
  // the token values on each shadow host isolates them from website CSS while
  // preserving one palette, font stack, radius scale, and elevation system.
  const READER_DESIGN_TOKENS = {};
  const READER_EN_MESSAGES = {};
  const readerUiRoots = new Set();
  const readerUiMessages = new WeakMap();
  let readerLocale = /^zh(?:-|$)/iu.test(navigator.language) ? 'zh-CN' : 'en';
  function updateReaderLocale(value) {
    const language = value === 'system' || !value ? navigator.language : value;
    readerLocale = /^zh(?:-|$)/iu.test(language) ? 'zh-CN' : 'en';
    const sourceKey = text => Object.keys(READER_EN_MESSAGES).find(key => READER_EN_MESSAGES[key] === text) || text;
    for (const shadow of readerUiRoots) {
      if (!shadow.host.isConnected) { readerUiRoots.delete(shadow); continue; }
      // Only extension controls are translated. Article and model text are
      // outside these button/label nodes and retain their original language.
      const walker = document.createTreeWalker(shadow, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.parentElement?.closest('button,.state')) continue;
        const current = node.textContent;
        const message = readerUiMessages.get(node);
        const key = message && (current === message || current === READER_EN_MESSAGES[message]) ? message : sourceKey(current);
        readerUiMessages.set(node, key);
        node.textContent = t(key);
      }
      shadow.querySelectorAll('[title],[aria-label]').forEach(element => {
        for (const attribute of ['title', 'aria-label']) {
          if (element.hasAttribute(attribute)) element.setAttribute(attribute, t(sourceKey(element.getAttribute(attribute))));
        }
      });
    }
  }
  function readerShadow(host, options) {
    const shadow = host.attachShadow(options);
    readerUiRoots.add(shadow);
    return shadow;
  }
  chrome.storage.local.get('readerUiLanguage').then(stored => {
    updateReaderLocale(stored.readerUiLanguage);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.readerUiLanguage) {
      updateReaderLocale(changes.readerUiLanguage.newValue);
      syncParagraphControl(focusedTranslationId);
    }
  });
  function t(message, ...values) {
    return (readerLocale === 'en' ? READER_EN_MESSAGES[message] || message : message).replace(/\{(\d+)\}/gu, (_, index) => String(values[Number(index)] ?? ''));
  }
  function localizedMarkup(markup) {
    return markup.replace(/>([^<>]*[\u3400-\u9fff][^<>]*)</gu, (_, text) => `>${t(text)}<`)
      .replace(/(aria-label|title|placeholder)="([^"]*)"/gu, (_, attribute, text) => `${attribute}="${t(text)}"`);
  }
  function applyReaderDesignTokens(element) {
    element.dataset.deepResearchDesignHost = 'true';
    // The shadow stylesheets start from `all:initial`, which resets the
    // native scheme. The Reader renders one palette, so the host states it
    // explicitly: scrollbars, carets and form controls stay readable instead
    // of inheriting a dark page's scheme.
    element.style.colorScheme = 'light';
    Object.entries(READER_DESIGN_TOKENS).forEach(([name, value]) => {
      element.style.setProperty(`--reader-${name}`, value);
    });
  }
  // The injected controls live in a shadow root on someone else's page, so
  // the shared token values are read directly from the generated source. The
  // value always comes from the shared token file — never a second literal.
  // The values are injected at build time from packages/design-system.
  const readerToken = (name) => READER_DESIGN_TOKENS[name] || 'currentColor';

  // An extension update can leave closed-shadow hosts in the page after the
  // previous isolated world is invalidated. Remove only transient controls;
  // translations and user annotations are intentionally preserved.
  document.querySelectorAll('[data-deep-research-paragraph-control],[data-deep-research-paragraph-highlight],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status]')
    .forEach((node) => node.remove());

  const MIN_INLINE_IMAGE_CONFIDENCE = 0.75;
  const READING_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,dt,dd,figcaption,caption,.sd-k,.sd-kv';
  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'NAV', 'HEADER', 'FOOTER', 'ASIDE']);
  function findRoot() {
    const hostname = location.hostname.toLowerCase();
    if (hostname === 'github.com' || hostname.endsWith('.github.com') || hostname === 'github.localhost') {
      // A comma-separated selector returns document order, not preference:
      // GitHub's outer main otherwise wins over the README and includes live
      // commit dates, file lists and controls in the article hash.
      return document.querySelector('#readme') || document.querySelector('[data-testid="readme-container"]')
        || document.querySelector('.markdown-body') || document.querySelector('article')
        || document.querySelector('main') || document.body;
    }
    if (hostname === 'zread.ai' || hostname.endsWith('.zread.ai') || hostname === 'zread.localhost') {
      return document.querySelector('article') || document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    }
    return document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
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
  const translatedOriginalDisplays = new WeakMap();
  const translatedOriginalAttributes = new WeakMap();
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

  function sourceBlockText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('[data-deep-research-translation]').forEach((item) => item.remove());
    return clean(clone.textContent || '');
  }

  function extractBlocks() {
    // Publishers sometimes use unadorned divs for article paragraphs.
    // Only add leaf containers outside semantic blocks, preserving structure.
    const leafContainers = Array.from(root.querySelectorAll('div,section'))
      .filter((node) => !node.closest(READING_BLOCK_SELECTOR))
      .filter((node) => !node.querySelector(`${READING_BLOCK_SELECTOR},div,section,script,style,form,button,input,textarea,select`))
      .filter((node) => /[\p{L}]{2}/u.test(sourceBlockText(node)));
    const nodes = [...Array.from(root.querySelectorAll(READING_BLOCK_SELECTOR)), ...leafContainers]
      .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      .filter((node) => !node.closest('[data-deep-research-translation]'))
      // Never treat a form or an editable control as article text. This is a
      // privacy boundary for pages that mix documentation with a comment,
      // search, or password form.
      .filter((node) => !node.closest('form, [contenteditable="true"],button,nav,[role="navigation"],script,style,[aria-hidden="true"]'))
      .filter((node) => !ignored.has(node.tagName))
      // Prefer the inner paragraph/list item when a table cell contains a
      // structured block. This keeps one source passage from entering the
      // translation queue twice while still covering plain table cells.
      .filter((node) => !node.matches('td,th,dt,dd') || !node.querySelector('h1,h2,h3,h4,p,li,blockquote,pre'));
    const blocks = [];
    nodes.forEach((node) => {
      // Read source DOM even when originals are hidden by translation. Nested
      // list/table blocks may contain injected sibling translations.
      const text = sourceBlockText(node);
      if (!text) return;
      const id = stableNodeId(node, 'block', blockIds, () => nextBlockId++);
      node.dataset.deepResearchBlock = id;
      blocks.push({ id, text, tag: node.tagName.toLowerCase(), kind: node.matches('pre,code') ? 'code' : 'text' });
    });
    // Keep every article block so a full-document request does not silently
    // omit short captions, headings, or long paragraphs.
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
    ].filter((node) => !node.closest('nav,header,footer,aside,[role="navigation"],[role="contentinfo"],.article-footer'));
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
            ? t("动画图片只处理明确标记的静态帧；当前图片未自动覆盖。")
            : sourceAvailable ? '' : t("图片没有可读取的数据或公开 URL；请允许图片访问后重试。"),
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
      warnings.push(t("当前页面没有识别到稳定的正文容器；全文范围可能不完整，建议直接选择原文段落操作。"));
    }
    if (!blocks.length && String(body || '').trim()) {
      warnings.push(t("当前页面正文尚未形成可处理的文本块；请等待页面加载或改用选段操作。"));
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
      warnings.push(t("当前页面包含 {0} 个跨域 iframe；扩展只处理当前页面 DOM，iframe 内容需在其页面单独启用。", crossOriginFrames.length));
    }
    return warnings;
  }

  function pageContext() {
    window.__deepResearchReaderRefresh();
    const blocks = extractBlocks();
    const fullBody = blocks.map((block) => block.text).join('\n\n');
    const body = fullBody;
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
      clone.querySelectorAll('script,style,noscript,form,[contenteditable="true"],nav,header,footer,aside,[data-deep-research-translation],[data-deep-research-paragraph-control],[data-deep-research-paragraph-highlight],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status]').forEach((node) => node.remove());
      fallback = clean(clone.innerText || clone.textContent || '');
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
      bodyTruncated: false,
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
      displayedTranslationLanguage: (() => {
        const languages = new Set(Array.from(document.querySelectorAll('[data-deep-research-translation]')).map(node => node.dataset.deepResearchTargetLanguage || ''));
        return languages.size === 1 ? [...languages][0] : null;
      })(),
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
    const body = allBlocks.map((block) => block.text).join('\n\n');
    return extractImagesForModel().then((imageData) => ({
      ...context,
      body: body || context.body,
      bodyCharCount: body.length || context.bodyCharCount,
      bodyTruncated: false,
      blocks: allBlocks,
      blockCount: allBlocks.length,
      blocksTruncated: false,
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
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = current;
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
      node = walker.nextNode();
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

  function isTranslationNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.('[data-deep-research-selection-translation]')
      || node?.getRootNode?.()?.host?.matches?.('[data-deep-research-selection-translation]'));
  }

  async function selectionContext() {
    const selection = window.getSelection();
    const quote = clean(selection?.toString() || '');
    if (!quote || isTranslationNode(selection?.anchorNode) || isTranslationNode(selection?.focusNode)) return null;
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

  let focusedTranslationId = null;
  let contextParagraphId = null;
  let paragraphControl = null;
  let paragraphHighlight = null;
  let selectedParagraphId = null;
  let paragraphHideTimer = 0;
  let lastParagraphPointer = { x: 0, y: 0 };
  let paragraphMenuState = '';
  let paragraphMenuLocked = false;
  function syncParagraphControl(id, forceMenu = false) {
    const original = id && document.querySelector(`[data-deep-research-block="${CSS.escape(id)}"]`);
    const translated = id && document.querySelector(`[data-deep-research-translation-for="${CSS.escape(id)}"]`);
    const available = Boolean(original && translated && translatedOriginalDisplays.has(original));
    const showingTranslation = available && translated.style.display !== 'none';
    const title = showingTranslation ? t("查看这一段原文") : t("查看这一段译文");
    const menuState = `${available ? id : ''}:${showingTranslation}`;
    if ((forceMenu || !paragraphMenuLocked) && (forceMenu || menuState !== paragraphMenuState)) {
      paragraphMenuState = menuState;
      send({ type: 'deep-research:paragraph-menu', available, showingTranslation });
    }
    if (!available) { if (paragraphControl) paragraphControl.style.display = 'none'; if (paragraphHighlight) paragraphHighlight.style.display = 'none'; return; }
    if (!paragraphHighlight) {
      paragraphHighlight = document.createElement('div');
      paragraphHighlight.setAttribute('data-deep-research-paragraph-highlight', 'true');
      paragraphHighlight.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147482999;box-sizing:border-box;border-radius:6px;';
      applyReaderDesignTokens(paragraphHighlight);
      document.body.appendChild(paragraphHighlight);
    }
    if (!paragraphControl) {
      paragraphControl = document.createElement('div');
      paragraphControl.setAttribute('data-deep-research-paragraph-control', 'true');
      paragraphControl.style.cssText = 'all:initial;position:fixed;z-index:2147483000;padding-top:4px;';
      applyReaderDesignTokens(paragraphControl);
      const shadow = readerShadow(paragraphControl, { mode: 'open' });
      shadow.innerHTML = '<style>:host{all:initial}.controls{display:flex;align-items:center;gap:8px;padding:4px 6px 4px 10px;border:1px solid var(--reader-color-outline-strong);border-radius:var(--reader-radius-small);background:var(--reader-color-surface-raised);box-shadow:var(--reader-elevation-1);font:400 var(--reader-type-caption)/1.5 var(--reader-font-family);color:var(--reader-color-text-secondary)}button{font:500 var(--reader-type-label)/1.4 var(--reader-font-family);min-height:32px;padding:6px 10px;border:0;border-radius:var(--reader-radius-small);background:transparent;color:var(--reader-color-primary);cursor:pointer}button:hover{background:var(--reader-color-primary-container)}button:focus-visible{outline:2px solid var(--reader-color-primary);outline-offset:2px}</style><div class="controls"><span class="state"></span><button type="button"></button></div>';
      shadow.querySelector('button').addEventListener('click', () => { toggleOriginalParagraph(focusedTranslationId); });
      document.body.appendChild(paragraphControl);
    }
    const button = paragraphControl.shadowRoot.querySelector('button');
    button.textContent = title;
    button.setAttribute('aria-label', title);
    button.title = t("{0}（Alt+Shift+O）；保留翻译，可随时切回", title);
    paragraphControl.shadowRoot.querySelector('.state').textContent = showingTranslation ? t("当前：译文") : t("当前：原文");
    paragraphControl.style.display = '';
    const box = (showingTranslation ? translated : original).getBoundingClientRect();
    paragraphHighlight.dataset.paragraphId = id;
    paragraphHighlight.dataset.selected = String(selectedParagraphId === id);
    paragraphHighlight.style.display = '';
    paragraphHighlight.style.left = `${box.left - 4}px`;
    paragraphHighlight.style.top = `${box.top - 4}px`;
    paragraphHighlight.style.width = `${box.width + 8}px`;
    paragraphHighlight.style.height = `${box.height + 8}px`;
    paragraphHighlight.style.border = `${selectedParagraphId === id ? 2 : 1}px solid var(--reader-color-primary)`;
    paragraphHighlight.style.background = 'color-mix(in srgb, var(--reader-color-primary) 7%, transparent)';
    const controlWidth = paragraphControl.getBoundingClientRect().width;
    paragraphControl.style.left = `${Math.max(8, Math.min(innerWidth - controlWidth - 8, box.right - controlWidth))}px`;
    paragraphControl.style.top = `${Math.max(8, Math.min(innerHeight - 44, box.bottom - 4))}px`;
  }
  function scheduleParagraphControlHide() {
    window.clearTimeout(paragraphHideTimer);
    paragraphHideTimer = window.setTimeout(() => {
      const target = document.elementFromPoint(lastParagraphPointer.x, lastParagraphPointer.y);
      if (target instanceof Element && target.closest('[data-deep-research-paragraph-control]')) return;
      if (translationIdForTarget(target) === focusedTranslationId) return;
      focusedTranslationId = selectedParagraphId;
      syncParagraphControl(selectedParagraphId);
    }, 280);
  }
  function updateFocusedParagraph(event) {
    if (event.type === 'pointerover') lastParagraphPointer = { x: event.clientX, y: event.clientY };
    if (event.target instanceof Element && event.target.closest('[data-deep-research-paragraph-control]')) {
      window.clearTimeout(paragraphHideTimer);
      return;
    }
    const nextId = translationIdForTarget(event.target);
    if (!nextId && event.type === 'pointerover' && focusedTranslationId) {
      scheduleParagraphControlHide();
      return;
    }
    window.clearTimeout(paragraphHideTimer);
    focusedTranslationId = nextId || selectedParagraphId;
    if (focusedTranslationId && event.type === 'pointerover') paragraphMenuLocked = false;
    syncParagraphControl(focusedTranslationId);
  }
  function translationIdForTarget(target) {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    const node = element?.closest('[data-deep-research-translation-for],[data-deep-research-block]');
    return node?.getAttribute('data-deep-research-translation-for') || node?.getAttribute('data-deep-research-block');
  }
  function contextTranslationId(event) {
    const direct = event.composedPath().map(translationIdForTarget).find(Boolean);
    if (direct) return direct;
    // Keyboard and accessibility context menus may target the document instead
    // of the focused paragraph. Never reuse a previous, unrelated hover.
    if (event.clientX === 0 && event.clientY === 0) return translationIdForTarget(document.activeElement);
    return null;
  }
  function toggleOriginalParagraph(id) {
    if (!id) return false;
    const original = document.querySelector(`[data-deep-research-block="${CSS.escape(id)}"]`);
    const translated = document.querySelector(`[data-deep-research-translation-for="${CSS.escape(id)}"]`);
    if (!original || !translated || !translatedOriginalDisplays.has(original)) return false;
    const showOriginal = translated.style.display !== 'none';
    original.style.display = showOriginal ? translatedOriginalDisplays.get(original) || '' : 'none';
    translated.style.display = showOriginal ? 'none' : translated.dataset.deepResearchDisplay || '';
    if (!translatedOriginalAttributes.has(original)) translatedOriginalAttributes.set(original, { title: original.getAttribute('title'), tabindex: original.getAttribute('tabindex') });
    original.title = t("右键或段落按钮可切回译文；Alt+Shift+O / Alt+单击也可切换");
    if (document.activeElement === translated && showOriginal) { original.tabIndex = 0; original.focus({ preventScroll: true }); }
    else if (document.activeElement === original && !showOriginal) translated.focus({ preventScroll: true });
    focusedTranslationId = id;
    selectedParagraphId = id;
    syncParagraphControl(id);
    return true;
  }
  document.querySelectorAll('[data-deep-research-translation-for]').forEach(translated => {
    const id = translated.getAttribute('data-deep-research-translation-for');
    const original = document.querySelector(`[data-deep-research-block="${CSS.escape(id)}"]`);
    if (!original) return;
    translatedOriginalDisplays.set(original, translated.dataset.deepResearchOriginalDisplay || '');
    try { const attributes = JSON.parse(translated.dataset.deepResearchOriginalAttributes || 'null'); if (attributes) translatedOriginalAttributes.set(original, attributes); } catch { /* Older translations have no persisted attributes. */ }
  });
  document.addEventListener('pointerover', updateFocusedParagraph, true);
  document.addEventListener('focusin', updateFocusedParagraph, true);
  document.addEventListener('pointerdown', event => {
    paragraphMenuLocked = false;
    if (event.button === 0 && !translationIdForTarget(event.target) && !event.composedPath().includes(paragraphControl)) {
      selectedParagraphId = null;
      focusedTranslationId = null;
      syncParagraphControl(null);
    }
    if (event.button !== 2) return;
    contextParagraphId = contextTranslationId(event);
    syncParagraphControl(contextParagraphId, true);
  }, true);
  document.addEventListener('contextmenu', event => {
    contextParagraphId = contextTranslationId(event);
    selectedParagraphId = contextParagraphId;
    // Native menu opening can emit a pointerover on a page-side overlay. Keep
    // the clicked paragraph's menu until another deliberate page interaction.
    paragraphMenuLocked = true;
    syncParagraphControl(contextParagraphId, true);
  }, true);
  window.addEventListener('focus', () => {
    if (!paragraphMenuLocked) syncParagraphControl(translationIdForTarget(document.activeElement) || selectedParagraphId, true);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { selectedParagraphId = null; focusedTranslationId = null; syncParagraphControl(null); }
  }, true);
  window.addEventListener('scroll', () => { if (paragraphControl?.style.display !== 'none') syncParagraphControl(focusedTranslationId); }, { passive: true });
  window.addEventListener('resize', () => syncParagraphControl(focusedTranslationId));
  document.addEventListener('click', event => {
    if (event.altKey && !isTypingTarget(event.target) && toggleOriginalParagraph(translationIdForTarget(event.target))) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  // Keep the lightweight toolbar useful without forcing the reader to reach
  // for the mouse. These are page-local shortcuts and deliberately avoid
  // firing while a user is typing in a form or editor.
  document.addEventListener('keydown', (event) => {
    paragraphMenuLocked = false;
    if (event.key === 'Escape') {
      removeSelectionTranslation();
      if (document.querySelector('[data-deep-research-image-zoom]')) closeImageZoom();
      if (toolbarHost) removeSelectionToolbar();
      return;
    }
    if (isTypingTarget(event.target) || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    const shortcuts = { t: 'translate', e: 'explain', q: 'ask', s: 'summary', k: 'save', m: 'annotate' };
    // Option changes event.key to a symbol on macOS (for example S → Í).
    // Physical letter codes keep the advertised Alt+Shift shortcuts usable.
    const letter = /^Key[A-Z]$/u.test(event.code || '') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (letter === 'o' && toggleOriginalParagraph(focusedTranslationId)) { event.preventDefault(); return; }
    const action = shortcuts[letter];
    if (!action || !lastSelectionContext) return;
    event.preventDefault();
    send({ type: 'deep-research:selection', context: lastSelectionContext });
    send({ type: 'deep-research:selection-action', action, context: lastSelectionContext });
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
    applyReaderDesignTokens(toolbarHost);
    // Same reasoning as the dock: the selection toolbar exposes real
    // actions, so it must stay reachable from assistive technology on every
    // Chromium build.
    const shadow = readerShadow(toolbarHost, { mode: 'open' });
    shadow.innerHTML = localizedMarkup(`
      <style>:host{all:initial}div{display:flex;gap:var(--reader-space-1);max-width:min(520px,calc(100vw - 16px));overflow-x:auto;padding:6px;border:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-medium);background:var(--reader-color-surface-raised);box-shadow:var(--reader-elevation-2);font:var(--reader-type-label)/1.4 var(--reader-font-family)}button{min-height:36px;border:0;border-radius:var(--reader-radius-small);background:transparent;color:var(--reader-color-text-secondary);padding:6px 10px;font:inherit;cursor:pointer;white-space:nowrap;transition:background-color var(--reader-motion-fast),color var(--reader-motion-fast)}button:hover{background:var(--reader-color-primary-container);color:var(--reader-color-primary)}button:focus-visible{outline:2px solid var(--reader-color-primary);outline-offset:2px}</style>
      <div role="toolbar" aria-label="Deep Research 阅读操作">
        <button data-action="explain" aria-keyshortcuts="Alt+Shift+E" title="Alt+Shift+E">解释这段</button><button data-action="translate" aria-keyshortcuts="Alt+Shift+T" title="Alt+Shift+T">翻译这段</button><button data-action="ask" aria-keyshortcuts="Alt+Shift+Q" title="Alt+Shift+Q">问这段</button><button data-action="save" aria-keyshortcuts="Alt+Shift+K" title="Alt+Shift+K">摘录</button>
      </div>`);
    shadow.querySelectorAll('button').forEach((button) => {
      button.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        send({ type: 'deep-research:selection', context });
        send({ type: 'deep-research:selection-action', action, context });
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
    applyReaderDesignTokens(readerDockHost);
    // The dock is a first-class interactive surface (summarize, translate,
    // open chat). A closed shadow root kept those buttons out of the
    // accessibility tree, so assistive technology could not reach them.
    // The host page still cannot target the controls: the host element
    // carries no layout styles and the shadow resets `all:initial`.
    const shadow = readerShadow(readerDockHost, { mode: 'open' });
    shadow.innerHTML = localizedMarkup(`
      <style>
        :host{all:initial}
        .dock{display:grid;gap:var(--reader-space-1);padding:var(--reader-space-1);border:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-large) var(--reader-radius-xs) var(--reader-radius-xs) var(--reader-radius-large);background:var(--reader-color-surface-raised);box-shadow:var(--reader-elevation-2)}
        button{position:relative;display:grid;width:44px;height:38px;place-items:center;border:0;border-radius:var(--reader-radius-small);background:transparent;color:var(--reader-color-primary);cursor:pointer;font:600 var(--reader-type-caption) var(--reader-font-family);transition:background-color var(--reader-motion-fast),color var(--reader-motion-fast)}
        button[data-action="open"]{height:40px;border-top:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-small) var(--reader-radius-xs) var(--reader-radius-xs) var(--reader-radius-small)}
        button:hover{background:var(--reader-color-primary-container)}
        button:focus-visible{outline:2px solid var(--reader-color-primary);outline-offset:2px}
        button::after{content:attr(data-tooltip);position:absolute;right:calc(100% + 8px);top:50%;z-index:1;transform:translateY(-50%) translateX(4px);padding:6px 9px;border:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-small);background:var(--reader-color-text);color:var(--reader-color-inverse-text);box-shadow:var(--reader-elevation-2);font:500 var(--reader-type-caption) var(--reader-font-family);white-space:nowrap;opacity:0;pointer-events:none;transition:opacity var(--reader-motion-fast),transform var(--reader-motion-fast)}
        button:hover::after,button:focus-visible::after{opacity:1;transform:translateY(-50%) translateX(0)}
        .glyph{display:grid;width:24px;height:24px;place-items:center;border-radius:var(--reader-radius-small);background:var(--reader-color-primary);color:var(--reader-color-inverse-text);letter-spacing:0}
        .quick{color:var(--reader-color-primary)}.quick svg{display:block;width:19px;height:19px}
        @media(prefers-reduced-motion:reduce){button{transition:none}}
      </style>
      <div class="dock" role="toolbar" aria-label="技术文章快捷入口">
        <button type="button" class="quick" data-action="summary" data-tooltip="总结本页" aria-label="总结本页" title="总结本页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg></button>
        <button type="button" class="quick" data-action="translate" data-tooltip="翻译本页" aria-label="翻译本页" title="翻译本页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 11"/><path d="m4 14 6-6 6 6"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg></button>
        <button type="button" data-action="open" data-tooltip="打开聊天" aria-label="打开聊天" title="打开 Deep Research Reader 聊天侧栏"><span class="glyph">R</span></button>
      </div>`);
    shadow.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.action === 'summary') setReaderStatus(t("正在读取正文并生成全文总结…"), 'loading');
      if (button.dataset.action === 'translate') setReaderStatus(t("正在读取正文，准备全文翻译…"), 'loading');
      if (button.dataset.action === 'open') setReaderStatus(t("正在打开聊天侧栏…"), 'loading');
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
      applyReaderDesignTokens(readerStatusHost);
      // The status strip announces translation progress, so its live region
      // has to be visible to assistive technology on every Chromium build.
      const shadow = readerShadow(readerStatusHost, { mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host{all:initial}
          .status{max-width:min(310px,calc(100vw - 96px));padding:var(--reader-space-2) 10px;border:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-small);background:var(--reader-color-text);color:var(--reader-color-inverse-text);box-shadow:var(--reader-elevation-2);font:700 var(--reader-type-caption)/1.4 var(--reader-font-family);opacity:0;transform:translateX(5px);transition:opacity var(--reader-motion-standard),transform var(--reader-motion-standard)}
          .status.visible{opacity:1;transform:translateX(0)}
          .status.ready{background:var(--reader-color-success);border-color:var(--reader-color-success-container)}
          .status.error{background:var(--reader-color-danger);border-color:var(--reader-color-danger-container)}
          .detail{display:block;margin-top:2px;color:var(--reader-color-on-inverse-muted);font-weight:500;font-size:var(--reader-type-caption)}
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
    try {
      chrome.runtime.sendMessage({ type: 'deep-research:from-page', payload }).catch(() => {});
    } catch {
      // Extension reloads invalidate page contexts before their DOM is replaced.
    }
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
    popup.dataset.deepResearchTranslation = 'true';
    popup.setAttribute('role', 'region');
    popup.setAttribute('aria-label', t("选段翻译"));
    applyReaderDesignTokens(popup);
    const shadow = readerShadow(popup, { mode: 'open' });
    shadow.innerHTML = localizedMarkup(`<style>
      :host{all:initial}
      *{box-sizing:border-box}
      .panel{display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;border:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-large);background:var(--reader-color-surface-raised);color:var(--reader-color-text);box-shadow:var(--reader-elevation-2);font:var(--reader-type-body)/var(--reader-line-height-body) var(--reader-font-family)}
      header{display:flex;align-items:center;flex:none;gap:var(--reader-space-1);padding:6px 8px;border-bottom:1px solid var(--reader-color-outline);font-size:var(--reader-type-label)}
      strong{margin-right:auto;white-space:nowrap}
      button{min-height:36px;border:0;border-radius:var(--reader-radius-small);padding:6px 10px;background:transparent;color:var(--reader-color-text-secondary);font:inherit;cursor:pointer;white-space:nowrap;transition:background-color var(--reader-motion-fast),color var(--reader-motion-fast)}
      button:hover{background:var(--reader-color-primary-container);color:var(--reader-color-primary)}button:focus-visible{outline:2px solid var(--reader-color-primary);outline-offset:2px}
      .text{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;cursor:text}
    </style><div class="panel"><header><strong>选段翻译</strong><button type="button" class="copy">复制</button><button type="button" class="expand" aria-pressed="false">放大</button><button type="button" class="close" aria-label="关闭选段翻译">关闭</button></header><div class="text" tabindex="0" aria-label="译文"></div></div>`);
    shadow.querySelector('.text').textContent = text.trim();
    const width = Math.min(440, window.innerWidth - 16);
    const anchor = rect.width || rect.height ? rect : fallbackRect;
    // Prefer space beside the source. Otherwise place below it, then above it.
    const beside = anchor.right + width + 16 <= window.innerWidth;
    const left = beside ? anchor.right + 8 : Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left));
    const below = window.innerHeight - anchor.bottom - 16;
    const top = beside ? Math.max(8, Math.min(anchor.top, window.innerHeight - 240))
      : below >= 180 ? anchor.bottom + 8 : Math.max(8, anchor.top - 300);
    popup.style.cssText = `position:fixed;z-index:2147483647;left:${left}px;top:${top}px;width:${width}px;height:${Math.min(300, Math.max(120, window.innerHeight - top - 8))}px;min-width:min(280px,calc(100vw - 16px));min-height:120px;max-width:calc(100vw - 16px);max-height:calc(100vh - ${top + 8}px);resize:both;overflow:hidden;pointer-events:auto;`;
    const initialStyle = popup.style.cssText;
    const expand = shadow.querySelector('.expand');
    expand.addEventListener('click', () => {
      const expanded = expand.getAttribute('aria-pressed') !== 'true';
      popup.style.cssText = expanded
        ? 'position:fixed;z-index:2147483647;inset:5vh 5vw;width:90vw;height:90vh;overflow:hidden;pointer-events:auto;'
        : initialStyle;
      applyReaderDesignTokens(popup);
      expand.textContent = expanded ? t("恢复") : t("放大");
      expand.setAttribute('aria-pressed', String(expanded));
    });
    shadow.querySelector('.copy').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(text.trim());
        button.textContent = t("已复制");
      } catch {
        button.textContent = t("请选中复制");
      }
    });
    shadow.querySelector('.close').addEventListener('click', () => popup.remove());
    popup.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); popup.remove(); }
    });
    // Keep host-page selection helpers away from the translation, without
    // preventing the browser's native text selection or clipboard shortcuts.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      popup.addEventListener(type, (event) => event.stopPropagation());
    }
    removeSelectionToolbar();
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
    if (!quote) return { error: t("原文摘录为空，无法定位") };
    if (anchor.contentHash) {
      const currentBody = pageContext().body;
      const currentHash = await contentHash(currentBody);
      if (!currentHash || currentHash !== anchor.contentHash) return { error: t("原文已变化，无法准确定位") };
    }
    // Publishers sometimes use unadorned divs for article paragraphs.
    // Only add leaf containers outside semantic blocks, preserving structure.
    const leafContainers = Array.from(root.querySelectorAll('div,section'))
      .filter((node) => !node.closest(READING_BLOCK_SELECTOR))
      .filter((node) => !node.querySelector(`${READING_BLOCK_SELECTOR},div,section,script,style,form,button,input,textarea,select`))
      .filter((node) => /[\p{L}]{2}/u.test(sourceBlockText(node)));
    const nodes = [...Array.from(root.querySelectorAll(READING_BLOCK_SELECTOR)), ...leafContainers]
      .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
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
      return { error: candidates.length === 0 ? t("原文已变化，无法准确定位") : t("原文存在多个可能位置，无法安全定位") };
    }
    const range = rangeForQuoteInElement(candidates[0], quote);
    if (!range) return { error: t("原文存在多个可能位置，无法安全定位") };
    return { target: candidates[0], range };
  }

  async function focusAnchor(anchor) {
    const resolved = await resolveAnchorRange(anchor);
    if (resolved.error) {
      send({ type: 'deep-research:anchor-unresolved', reason: resolved.error });
      return;
    }
    const translated = resolved.target.nextElementSibling;
    if (getComputedStyle(resolved.target).display === 'none'
      && translated?.hasAttribute('data-deep-research-translation')) {
      toggleOriginalParagraph(translated.getAttribute('data-deep-research-translation-for'));
    }
    const target = resolved.target;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const previousOutline = target.style.outline;
    const previousOffset = target.style.outlineOffset;
    target.style.outline = `2px solid ${readerToken('color-primary')}`;
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

  // Latest apply request per annotation id. Applying awaits anchor resolution
  // (SHA-256), so a newer apply or a clear must invalidate older in-flight ones.
  const pendingAnnotationApplies = new Map();
  let annotationApplySeq = 0;

  function clearAnnotationHighlights() {
    pendingAnnotationApplies.clear();
    Array.from(annotationHighlights.keys()).forEach(removeAnnotationHighlight);
  }

  async function applyAnnotationHighlight(annotation) {
    if (!annotation?.id || !annotation.anchor?.quote) return false;
    removeAnnotationHighlight(annotation.id);
    const token = ++annotationApplySeq;
    pendingAnnotationApplies.set(annotation.id, token);
    const resolved = await resolveAnchorRange(annotation.anchor);
    if (pendingAnnotationApplies.get(annotation.id) !== token) return false;
    pendingAnnotationApplies.delete(annotation.id);
    removeAnnotationHighlight(annotation.id);
    if (resolved.error) {
      send({ type: 'deep-research:annotation-unresolved', id: annotation.id, reason: resolved.error });
      return false;
    }
    const host = document.createElement('span');
    host.dataset.deepResearchAnnotationHighlight = annotation.id;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;';
    applyReaderDesignTokens(host);
    const update = () => {
      host.textContent = '';
      Array.from(resolved.range.getClientRects()).forEach((rect) => {
        if (!rect.width || !rect.height) return;
        const mark = document.createElement('span');
        mark.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:var(--reader-color-highlight);border-bottom:2px solid var(--reader-color-highlight-border);border-radius:2px;`;
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
    applyReaderDesignTokens(host);
    const shadow = readerShadow(host, { mode: 'open' });
    shadow.innerHTML = localizedMarkup(`
      <style>
        :host{all:initial} .backdrop{position:fixed;inset:0;display:grid;place-items:center;padding:var(--reader-space-6);background:var(--reader-color-scrim);cursor:zoom-out;font:var(--reader-type-body)/var(--reader-line-height-body) var(--reader-font-family)}
        .frame{position:relative;display:flex;max-width:min(94vw,1400px);max-height:92vh;align-items:center;justify-content:center;padding:var(--reader-space-3);border:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-medium);background:var(--reader-color-surface-raised);box-shadow:var(--reader-elevation-2);cursor:default}
        .frame img,.frame svg{display:block;max-width:88vw;max-height:86vh;width:auto;height:auto;object-fit:contain}
        .close{position:absolute;right:8px;top:8px;width:40px;height:40px;border:1px solid var(--reader-color-outline-strong);border-radius:var(--reader-radius-small);background:var(--reader-color-surface-raised);color:var(--reader-color-text);font-size:var(--reader-type-title-compact);line-height:1;cursor:pointer}
        .hint{position:absolute;left:12px;bottom:8px;color:var(--reader-color-on-inverse-muted);font-size:var(--reader-type-caption)}
      </style>
      <div class="backdrop" role="dialog" aria-label="放大查看原图"><div class="frame"><button class="close" type="button" aria-label="关闭">×</button><span class="hint">点击背景或按 Esc 关闭</span></div></div>`);
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

  async function selectReadingImage(image) {
      // Clicking a figure can leave the previous paragraph selected. Clear it
      // before emitting the image scope so the debounced selection observer
      // cannot arrive afterward and replace the image discussion context.
      window.getSelection()?.removeAllRanges();
      const isSvg = image.tagName?.toLowerCase() === 'svg';
      const width = Number(image.naturalWidth || image.width || image.getBoundingClientRect().width || 0);
      const height = Number(image.naturalHeight || image.height || image.getBoundingClientRect().height || 0);
      const rawDataUrl = isSvg ? readSvgDataUrl(image) : isLikelyAnimatedImage(image) ? null : readImageDataUrl(image);
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
          status: isLikelyAnimatedImage(image) ? 'animated' : 'ready',
        },
      });
  }

  function addImageControls(wrapper, image, layer, fallback, sideLayer = null) {
    const control = document.createElement('span');
    control.dataset.deepResearchImageControl = 'true';
    control.style.cssText = 'position:absolute;top:6px;right:6px;z-index:3;line-height:normal;';
    applyReaderDesignTokens(control);
    const shadow = readerShadow(control, { mode: 'open' });
    const animated = isLikelyAnimatedImage(image);
    shadow.innerHTML = localizedMarkup(t("\n      <style>\n        :host{all:initial} .controls{display:flex;gap:var(--reader-space-1);padding:var(--reader-space-1);border:1px solid var(--reader-color-outline);border-radius:var(--reader-radius-small);background:var(--reader-color-surface-raised);box-shadow:var(--reader-elevation-2);font:var(--reader-type-caption) var(--reader-font-family)}\n        button{min-height:36px;border:0;border-radius:var(--reader-radius-small);padding:8px 12px;background:transparent;color:var(--reader-color-primary);cursor:pointer;white-space:nowrap;font:500 var(--reader-type-label)/1.5 var(--reader-font-family);transition:background-color var(--reader-motion-fast)}button:hover{background:var(--reader-color-primary-container)}button:focus-visible{outline:2px solid var(--reader-color-primary);outline-offset:2px}\n      </style><span class=\"controls\" role=\"toolbar\" aria-label=\"图片阅读操作\"><button type=\"button\" data-action=\"toggle\">原图</button><button type=\"button\" data-action=\"zoom\">放大</button>{0}<button type=\"button\" data-action=\"explain\">解读</button></span>", animated ? '<button type="button" data-action="static-frame">当前帧</button>' : ''));
    const toggle = shadow.querySelector('[data-action="toggle"]');
    let showingOriginal = false;
    toggle.addEventListener('click', () => {
      showingOriginal = !showingOriginal;
      if (layer) layer.style.display = showingOriginal ? 'none' : '';
      if (sideLayer) sideLayer.style.display = showingOriginal ? 'none' : '';
      if (fallback) fallback.style.display = showingOriginal ? 'none' : '';
      toggle.textContent = showingOriginal ? t("译文") : t("原图");
      toggle.setAttribute('aria-label', showingOriginal ? t("显示译文") : t("显示原图"));
    });
    shadow.querySelector('[data-action="zoom"]').addEventListener('click', () => showImageZoom(image));
    shadow.querySelector('[data-action="static-frame"]')?.addEventListener('click', (event) => {
      image.setAttribute('data-deep-research-static-frame', 'true');
      event.currentTarget.textContent = t("已标记");
      event.currentTarget.setAttribute('aria-label', t("已标记当前帧，点击全文翻译后处理"));
      // Re-snapshot the page so a running full-document task can enqueue this
      // now-explicit static frame.  The original animation remains untouched
      // until the user asks for the translation.
      send({ type: 'deep-research:request-page' });
    });
    shadow.querySelector('[data-action="explain"]').addEventListener('click', () => void selectReadingImage(image));
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
    applyReaderDesignTokens(wrapper);
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
          ? Math.max(8, Math.min(18, regionWidth * 0.58 * renderScale))
          : Math.max(8, Math.min(24, regionHeight * 0.5 * renderScale));
        // Opaque fill is intentional: a translucent box leaves source glyphs
        // visible underneath and can create a false bilingual reading. The
        // original image remains one click away through the image control.
        label.style.cssText = `position:absolute;left:${(x / width) * 100}%;top:${(y / height) * 100}%;width:${(regionWidth / width) * 100}%;min-height:${(regionHeight / height) * 100}%;padding:1px 1px;box-sizing:border-box;background:var(--reader-color-surface);color:var(--reader-color-text);font:600 ${fontSize}px/1.12 var(--reader-font-family);white-space:normal;overflow:hidden;word-break:break-word;${verticalLabel ? 'writing-mode:vertical-rl;text-orientation:mixed;' : ''}`;
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
          ? t("原文：{0}\n译文：{1}", sourceText.slice(0, 120), String(text || '').trim())
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
          sourceLine.textContent = t("原文  {0}", sourceText.slice(0, 120));
          sourceLine.style.cssText = 'display:block;margin-bottom:3px;color:var(--reader-color-warning);font:500 var(--reader-type-caption)/1.35 var(--reader-font-family);';
          label.appendChild(sourceLine);
        }
        const translationLine = document.createElement('span');
        translationLine.textContent = translatedText;
        translationLine.style.cssText = 'display:block;color:var(--reader-color-image-translation);font:600 var(--reader-type-caption)/1.4 var(--reader-font-family);';
        label.appendChild(translationLine);
        const sideText = sourceText ? t("原文 {0}\n{1}", sourceText.slice(0, 120), translatedText) : translatedText;
        const sideHeight = Math.min(180, Math.max(42, 28 + (Math.ceil(sideText.length / 24) * 16)));
        label.style.cssText = 'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + sideWidth + 'px;min-height:' + sideHeight + 'px;box-sizing:border-box;padding:6px 8px;border:1px solid var(--reader-color-warning);border-radius:var(--reader-radius-small);background:var(--reader-color-image-translation-container);color:var(--reader-color-image-translation);white-space:normal;overflow-wrap:anywhere;box-shadow:var(--reader-elevation-1);';
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
      fallback.textContent = t("旁侧译文：{0}", safeFallback);
      fallback.style.cssText = 'position:relative;z-index:2;margin-top:var(--reader-space-2);padding:7px 9px;border-left:3px solid var(--reader-color-warning);border-radius:var(--reader-radius-xs);background:var(--reader-color-warning-container);color:var(--reader-color-warning);font:var(--reader-type-label)/1.55 var(--reader-font-family);white-space:pre-wrap;';
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

  document.addEventListener('mouseup', (event) => {
    if (event.composedPath().some(isTranslationNode)) return;
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
    const selection = window.getSelection();
    if (isTranslationNode(selection?.anchorNode) || isTranslationNode(selection?.focusNode)) return;
    if (!selection?.toString().trim()) {
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
      if (target && root.isConnected && !root.contains(target) && !target.contains(root)) return false;
      if (target?.closest('[data-deep-research-translation],[data-deep-research-selection-translation],[data-deep-research-paragraph-control],[data-deep-research-paragraph-highlight],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status],[data-deep-research-image-control],[data-deep-research-image-zoom],[data-deep-research-annotation-highlight]')) return false;
      if (record.type === 'childList' && record.removedNodes.length > 0 && Array.from(record.removedNodes).every((node) => node instanceof Element && node.matches('[data-deep-research-translation],[data-deep-research-selection-translation],[data-deep-research-paragraph-control],[data-deep-research-paragraph-highlight],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status],[data-deep-research-image-control],[data-deep-research-image-zoom],[data-deep-research-annotation-highlight]'))) return false;
      return record.type === 'childList' && (Array.from(record.addedNodes).some((node) => {
        return !(node instanceof Element && node.closest('[data-deep-research-translation],[data-deep-research-selection-translation],[data-deep-research-paragraph-control],[data-deep-research-paragraph-highlight],[data-deep-research-toolbar],[data-deep-research-dock],[data-deep-research-status],[data-deep-research-image-control],[data-deep-research-image-zoom]'));
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'deep-research:clear-native-selection') {
      window.getSelection()?.removeAllRanges();
      lastSelectionContext = null;
      lastSelectionRange = null;
      removeSelectionToolbar();
      return;
    }
    if (message?.type === 'deep-research:reader-status') {
      const tone = message.state === 'ready' ? 'ready' : message.state === 'error' ? 'error' : 'loading';
      setReaderStatus(String(message.label || t("正在读取正文")), tone, String(message.detail || ''));
    }
    if (message?.type === 'deep-research:focus-page') {
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (message?.type === 'deep-research:toggle-paragraph') {
      paragraphMenuLocked = false;
      toggleOriginalParagraph(contextParagraphId);
      return;
    }
    if (message?.type === 'deep-research:context-action') {
      void (async () => {
        const context = await selectionContext();
        if (context) { lastSelectionContext = context; send({ type: 'deep-research:selection', context }); send({ type: 'deep-research:selection-action', action: message.action, context }); }
        else send({ type: 'deep-research:page-action', action: message.action });
      })();
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
    if (message?.type === 'deep-research:select-image' && typeof message.src === 'string') {
      const image = Array.from(root.querySelectorAll('img')).find(node => (node.currentSrc || node.src) === message.src);
      if (image && !image.closest('form,[contenteditable="true"]')) void selectReadingImage(image);
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
      if (message.documentUrl && message.documentUrl !== sourceUrl()) {
        sendResponse?.({ ok: false, appliedIds: [] });
        return;
      }
      let appliedCount = 0;
      const appliedIds = [];
      const failedItems = [];
      const fail = (id, reason) => failedItems.push({ id, error: reason });
      translations.forEach(({ id, text, sourceText, targetLanguage }) => {
        if (id === 'selection') {
          if (applySelectionTranslation(text, sourceText)) { appliedCount += 1; appliedIds.push(id); }
          else fail(id, t("选段已变化，译文未显示；请重新选择后重试。"));
          return;
        }
        const node = id === 'selection' && lastSelectionNode?.isConnected
          ? lastSelectionNode
          : document.querySelector(`[data-deep-research-block="${CSS.escape(id)}"]`);
        if (!node || !text) { fail(id, t("原文节点已变化，译文未显示；请重新开启全文翻译。")); return; }
        // DOM updates can reorder block ids between the request and the
        // response. Refuse to attach a translation to a different paragraph;
        // the user can retry after the viewport context is refreshed.
        if (typeof sourceText === 'string' && sourceBlockText(node) !== clean(sourceText)) {
          fail(id, t("本段原文已变化，旧译文未显示；请重新开启全文翻译。")); return;
        }
        const existing = document.querySelector(`[data-deep-research-translation-for="${CSS.escape(id)}"]`);
        if (existing) { existing.textContent = text; existing.dataset.deepResearchTargetLanguage = targetLanguage || ''; appliedIds.push(id); return; }
        if (getComputedStyle(node).display === 'none' && translatedOriginalDisplays.has(node)) {
          node.style.display = translatedOriginalDisplays.get(node) || '';
        }
        if (getComputedStyle(node).display === 'none') {
          fail(id, t("原文当前不可显示，译文未应用；请展开内容后重试。")); return;
        }
        const translated = document.createElement(node.tagName.toLowerCase());
        for (const attribute of ['class', 'style', 'dir', 'lang', 'role']) {
          const value = node.getAttribute(attribute);
          if (value !== null) translated.setAttribute(attribute, value);
        }
        if (node.matches('td,th')) {
          for (const attribute of ['colspan', 'rowspan', 'scope', 'headers']) {
            const value = node.getAttribute(attribute);
            if (value !== null) translated.setAttribute(attribute, value);
          }
        }
        translated.dataset.deepResearchTranslation = 'true';
        translated.dataset.deepResearchTargetLanguage = targetLanguage || '';
        translated.dataset.deepResearchTranslationFor = id;
        translated.textContent = text;
        translated.dataset.deepResearchDisplay = getComputedStyle(node).display;
        translated.tabIndex = 0;
        translated.title = t("右键或段落按钮可查看原文；Alt+Shift+O / Alt+单击也可切换");
        translated.style.setProperty('display', getComputedStyle(node).display);
        translated.style.setProperty('border-inline-start', 'none', 'important');
        translated.style.setProperty('padding-inline-start', '0', 'important');
        translated.dataset.deepResearchOriginalDisplay = node.style.display;
        translated.dataset.deepResearchOriginalAttributes = JSON.stringify({ title: node.getAttribute('title'), tabindex: node.getAttribute('tabindex') });
        translatedOriginalDisplays.set(node, node.style.display);
        node.style.display = 'none';
        node.insertAdjacentElement('afterend', translated);
        appliedCount += 1;
        appliedIds.push(id);
      });
      const result = { ok: true, appliedIds, failedItems, count: appliedCount };
      sendResponse?.(result);
      send({ type: 'deep-research:translations-applied', ...result });
    }
    if (message?.type === 'deep-research:apply-image-translations') {
      const translations = Array.isArray(message.translations) ? message.translations : [];
      let appliedCount = 0;
      const appliedIds = [];
      translations.forEach((translation) => {
        if (applyImageTranslation(translation.id, translation.regions, translation.confidence, translation.fallbackText, translation.fallbackRegions)) {
          appliedCount += 1;
          appliedIds.push(translation.id);
        }
      });
      send({ type: 'deep-research:image-translations-applied', count: appliedCount, appliedIds });
    }
    if (message?.type === 'deep-research:restore-translations') {
      selectedParagraphId = null;
      focusedTranslationId = null;
      syncParagraphControl(null);
      document.querySelectorAll('[data-deep-research-translation]').forEach((node) => {
        const id = node.getAttribute('data-deep-research-translation-for');
        const original = id
          ? document.querySelector(`[data-deep-research-block="${CSS.escape(id)}"]`)
          : node.previousElementSibling;
        if (original && translatedOriginalDisplays.has(original)) {
          original.style.display = translatedOriginalDisplays.get(original) || '';
          translatedOriginalDisplays.delete(original);
          const attributes = translatedOriginalAttributes.get(original);
          if (attributes) {
            for (const [name, value] of Object.entries(attributes)) {
              if (value === null) original.removeAttribute(name); else original.setAttribute(name, value);
            }
            translatedOriginalAttributes.delete(original);
          }
        }
        node.remove();
      });
      paragraphMenuLocked = false;
      focusedTranslationId = null; contextParagraphId = null; syncParagraphControl(null, true);
      removeSelectionTranslation();
      restoreImageTranslations();
      if (!message.silent) send({ type: 'deep-research:translations-restored' });
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
