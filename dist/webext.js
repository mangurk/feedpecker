// Promise-based wrappers around the callback API supported by Chromium and Firefox.
// Keeping this adapter local avoids a runtime dependency or remote code.
(function initializeWebExtensionAdapter() {
  if (globalThis.feedpeckerWebExt) return;

  if (typeof chrome === 'undefined' || !chrome.storage?.local || !chrome.runtime) {
    globalThis.feedpeckerWebExt = Object.freeze({ storage: null, tabs: null });
    return;
  }

  const api = chrome;

  function callWithCallback(invoke) {
    return new Promise((resolve, reject) => {
      try {
        invoke(result => {
          const error = api.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  globalThis.feedpeckerWebExt = Object.freeze({
    storage: Object.freeze({
      get: keys => callWithCallback(done => api.storage.local.get(keys, done)),
      set: values => callWithCallback(done => api.storage.local.set(values, done)),
      remove: keys => callWithCallback(done => api.storage.local.remove(keys, done))
    }),
    tabs: Object.freeze({
      query: queryInfo => callWithCallback(done => api.tabs.query(queryInfo, done)),
      sendMessage: (tabId, message) => callWithCallback(done => api.tabs.sendMessage(tabId, message, done))
    })
  });
})();
