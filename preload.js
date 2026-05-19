const { contextBridge } = require("electron");

// Expose a tiny, read-only surface for diagnostics without enabling Node in the page.
contextBridge.exposeInMainWorld("ytmDesktop", {
    platform: process.platform,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
});
