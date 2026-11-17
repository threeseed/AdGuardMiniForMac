
/**
 * Represents a browser tab.
 *
 * @typedef {Object} Tab
 * @property {number} id - Unique identifier of the tab.
 * @property {number} index - The tab's position within its window (starting at 0).
 * @property {number} windowId - The identifier of the window that contains the tab.
 * @property {string} [url] - The URL loaded in the tab.
 * @property {string} [title] - The title of the tab.
 * @property {boolean} active - Indicates if the tab is currently active.
 * @property {boolean} highlighted - Indicates if the tab is highlighted.
 * @property {boolean} pinned - Indicates if the tab is pinned.
 * @property {boolean} incognito - Indicates if the tab is opened in incognito mode.
 * @property {"loading" | "complete"} status - The loading status of the tab (e.g., "loading" or "complete").
 * @property {string} [favIconUrl] - The URL of the tab's favicon.
 */

/**
 * Message types
 */
const MessageType = Object.freeze({
    // Extra
    /**
     * Update extra status from the main app
     */
    extraStatusUpdate: "extraStatusUpdate",
    /**
     * Inject extra script into the tab
     */
    injectExtraScript: "injectExtraScript",
    /**
     * Request extra script from tab
     */
    requestExtraFromTab: "requestExtraFromTab",

    // Advanced blocking
    /**
     * Request advanced blocking data from the main app
     */
    advancedBlockingData: "advancedBlockingData",
    /**
     * Send result of advanced blocking data to the tab
     */
    advancedBlockingDataResult: "advancedBlockingDataResult",
    /**
     * Request advanced blocking data from the tab
     */
    requestAdvancedBlockingDataFromTab: "requestAdvancedBlockingDataFromTab",
});

/**
 * Fetch "extra" contents script module
 */
const fetchExtraScript = (function () {
    let cachedAdGuardExtra = null;
    let promise = null;

    /**
     * Download "extra" contents script module once
     * 
     * @param {string} dataURL
     * @returns {Promise<string>}
     */
    async function downloadOnce(dataURL) {
        const res = await fetch(dataURL);
        const scriptText = await res.text();
        promise = null;
        cachedAdGuardExtra = scriptText;
        return scriptText;
    }

    /**
     * Fetch "extra" contents script module
     * 
     * @returns {Promise<string>}
     */
    return async function fetchExtraScript() {
        if (cachedAdGuardExtra) {
            return cachedAdGuardExtra;
        }

        if (promise) {
            return promise;
        }

        let dataURL = browser.runtime.getURL('adguard-extra.js');

        return promise = downloadOnce(dataURL);
    }
})();

/**
 * Extra status manager module
 */
const extraStatusManager = (function () {
    const ALARM_NAME = "updateExtraStatus";
    // I will try to update extra status every 0.5 minutes, but it's not guaranteed.
    // https://developer.chrome.com/docs/extensions/reference/api/alarms?hl=ru
    const EXTRA_STATUS_UPDATE_INTERVAL_MINUTES = 0.5;

    // A status older than this is refreshed on demand instead of by a fixed poll.
    const EXTRA_STATUS_MAX_AGE_MS = 5000;

    let _canUseExtra = false;
    let _gotResponseFromBackend = false;
    let _verbose = false;
    let _promise = null;
    let _lastRequestTime = 0;
    let _inFlight = null;

    /**
     * Request extra status from the main app
     * 
     * @returns {Promise<void>}
     */
    async function requestExtraStatus() {
        try {
            const result = await requestMainApp(MessageType.extraStatusUpdate);

            _gotResponseFromBackend = true;
            if (typeof result === "object") {
                _canUseExtra = result.isActive;
                _verbose = result.verbose;
            } else {
                throw new Error("Invalid extra status response", { cause: result });
            }
        } catch (e) {
            console.error("Error while requesting extra status", e.message, e.cause);
        }
    }

    browser.alarms.create(ALARM_NAME, {
        periodInMinutes: EXTRA_STATUS_UPDATE_INTERVAL_MINUTES
    });

    /**
     * Starts a status request unless one is already in flight
     *
     * @returns {Promise<void>}
     */
    function refresh() {
        if (_inFlight) {
            return _inFlight;
        }
        _lastRequestTime = Date.now();
        _inFlight = requestExtraStatus().finally(() => {
            _inFlight = null;
        });
        _promise = _inFlight;
        return _inFlight;
    }

    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARM_NAME) {
            refresh();
        }
    });

    refresh();

    return Object.freeze({
        /**
         * Check if "extra" contents script module can be used
         * 
         * @returns {Promise<boolean>}
         */
        async canUseExtra() {
            if (Date.now() - _lastRequestTime > EXTRA_STATUS_MAX_AGE_MS) {
                refresh();
            }
            return _promise.then(() => _canUseExtra && _gotResponseFromBackend);
        },

        /**
         * Get verbose mode
         * @returns {boolean}
         */
        get verbose() {
            return _verbose;
        }
    });
})();

/**
 * Rules TTL-cache module
 */
const rulesCache = (function () {
    const CLEANUP_ALARM_NAME = "rulesCacheCleanup";
    const CACHE_TTL = 120000; // Record cache TTL

    // Create alarm that will be triggered every 1 minute
    browser.alarms.create(CLEANUP_ALARM_NAME, {
        periodInMinutes: 1
    });

    // Listen for alarm triggers
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === CLEANUP_ALARM_NAME) {
            cleanupExpired();
        }
    });

    // Map, where key is URL and value is object { payload, timestamp }
    const cacheMap = new Map();

    /**
     * Cleanup expired entries
     */
    function cleanupExpired() {
        const now = Date.now();

        // Shrink cache if it's too big
        const shouldShrink = cacheMap.size > 1200;
        const shrinkThreshold = cacheMap.size * 0.5;

        let cutCount = 0;
        for (const [url, entry] of cacheMap) {
            if (now - entry.timestamp > CACHE_TTL || (shouldShrink && cutCount < shrinkThreshold)) {
                cacheMap.delete(url);
                cutCount++;
            }
        }

        if (shouldShrink) {
            console.warn(`Cache is too big. Cut ${cutCount} entries.`);
        }
    }

    /**
     * Get data by URL from cache (if not expired).
     * 
     * @param {string} url 
     * @returns {any|null} null, if there is no data or it expired
     */
    function get(url) {
        const entry = cacheMap.get(url);
        if (!entry) {
            return null;
        }

        // Consider this is a hot record, and update timestamp
        entry.timestamp = Date.now();

        return entry.payload;
    }

    /**
     * Write data for URL with actual timestamp
     * 
     * @param {string} url 
     * @param {any} payload 
     */
    function set(url, payload) {
        cacheMap.set(url, { payload, timestamp: Date.now() });
    }

    return Object.freeze({ get, set });
})();


/**
 * Send message to main app then return response
 *
 * @returns {Promise<any>}
 */
function requestMainApp(action, request) {
    return browser.runtime.sendNativeMessage("app.id", {
        action,
        ...(request || {})
    });
}

/**
 * Send message to special tab
 *
 * @returns {Promise<any>}
 */
function requestTab(tabId, request) {
    return browser.tabs.sendMessage(tabId, request);
}

/**
 * Pipes extra script from the main app to the tab
 * 
 * @param {number} tabId
 */
async function pipeExtraScriptToTab(tabId) {
    if (await extraStatusManager.canUseExtra()) {
        try {
            const script = await fetchExtraScript();

            await requestTab(tabId, {
                type: MessageType.injectExtraScript,
                script,
                verbose: extraStatusManager.verbose
            });
        } catch (error) {
            console.error("Error while injecting extra script", error);
        }
    }
}

/**
 * In-flight advanced blocking requests keyed by URL, so concurrent callers share one native round trip
 * @type {Map<string, Promise<any|null>>}
 */
const pendingAdvancedBlockingRequests = new Map();

/**
 * Checks that the URL can carry advanced blocking rules
 *
 * @param {string} url
 * @returns {boolean}
 */
function isHttpUrl(url) {
    return typeof url === "string" && (url.startsWith("http:") || url.startsWith("https:"));
}

/**
 * Requests advanced blocking data for the URL from the main app and caches it
 *
 * @param {string} url
 * @returns {Promise<any|null>} null when there is no data
 */
function fetchAdvancedBlockingData(url) {
    const pending = pendingAdvancedBlockingRequests.get(url);
    if (pending) {
        return pending;
    }
    const request = requestMainApp(MessageType.advancedBlockingData, { url })
        .then((result) => {
            if (Array.isArray(result) && result.length > 0) {
                rulesCache.set(url, result[0]);
                return result[0];
            }
            return null;
        })
        .finally(() => {
            pendingAdvancedBlockingRequests.delete(url);
        });
    pendingAdvancedBlockingRequests.set(url, request);
    return request;
}

/**
 * Pipes advanced blocking data from the main app to the tab
 * 
 * @param {number} tabId
 * @param {string} url Requested URL, not tab URL
 */
async function pipeAdvancedBlockingDataToTab(tabId, url) {
    if (!isHttpUrl(url)) {
        return;
    }
    try {
        const advancedBlockingData = rulesCache.get(url) ?? await fetchAdvancedBlockingData(url);
        if (!advancedBlockingData) {
            return;
        }

        await requestTab(tabId, {
            type: MessageType.advancedBlockingDataResult,
            ...advancedBlockingData
        });
    } catch (error) {
        console.error("Error while requesting advanced blocking data", error);
    }
}

/**
 * Tabs changes subscriber. Extra is not pushed from here: every frame's injector requests it itself.
 * 
 * @param {Tab} tab
 */
function tabInfoUpdateListener(tab) {
    if (!tab.url) {
        return;
    }

    pipeAdvancedBlockingDataToTab(tab.id, tab.url);
}

browser.tabs.onCreated.addListener(tabInfoUpdateListener);
browser.tabs.onUpdated.addListener((_, changeInfo, tab) => {
    // Title, favicon and "complete" updates do not change the rules a tab needs.
    if (changeInfo.url || changeInfo.status === "loading") {
        tabInfoUpdateListener(tab);
    }
});

// Prefetch the data when the extension or page is loaded
fetchExtraScript().then(() => {
    console.log("adguard-extra.js is prefetched and cached.", Date.now());
}).catch(error => {
    console.error("Error prefetching adguard-extra.js:", error);
});

browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type === MessageType.requestExtraFromTab) {
        pipeExtraScriptToTab(sender.tab.id);
    } else if (message.type === MessageType.requestAdvancedBlockingDataFromTab) {
        pipeAdvancedBlockingDataToTab(sender.tab.id, message.url);
    }
});

/**
 * @TODO:
 * - Log errors from here to swift somehow (send message with severity?)
 * - Check verbose mode (Do we need it?)
 * - Fix blockElement ping-pong
 * - Check script.js file. I think this file should be renamed.
 */
