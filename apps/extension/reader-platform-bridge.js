(() => {
  const storeUrl = 'https://chromewebstore.google.com/detail/bldpmkepljipbadeegednfinnilgoedl';
  const sourceSelector = '[data-reader-launch-source]';

  function getLaunchTarget(element) {
    if (!(element instanceof Element)) return null;
    const control = element.closest(sourceSelector);
    if (!control) return null;
    const value = control.getAttribute('data-reader-launch-source');
    if (!value) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      if (url.searchParams.get('deep-research-source') !== 'radar') return null;
      if (!url.searchParams.get('deep-research-summary')) return null;
      const platformHint = url.searchParams.get('deep-research-platform');
      if (platformHint) {
        if (new URL(platformHint).origin !== location.origin) return null;
      } else {
        // Server-rendered buttons can be clicked before React's origin effect
        // runs. The content script already knows the trusted page origin.
        url.searchParams.set('deep-research-platform', location.origin);
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  function guideInstallation() {
    location.assign(storeUrl);
  }

  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const sourceUrl = getLaunchTarget(event.target);
    if (!sourceUrl) return;

    // The extension handles this trusted click so it can open its native
    // side panel in the same user-gesture turn. The app's own click handler is
    // the no-extension fallback and routes to the install guide.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    chrome.runtime.sendMessage({ type: 'deep-research:open-reader-source', url: sourceUrl }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !response?.ok) guideInstallation(sourceUrl);
    });
  }, true);
})();
