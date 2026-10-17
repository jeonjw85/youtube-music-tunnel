const assert = require("node:assert/strict");
const test = require("node:test");
const { loadMain } = require("./helpers/main-harness");

const cases = [
    { url: "https://music.youtube.com/", internal: true },
    { url: "https://accounts.google.com/signin", internal: true },
    { url: "https://www.youtube.com/watch?v=test", internal: true },
    { url: "https://www.gstatic.com/", internal: true },
    { url: "http://accounts.google.com/", external: true },
    { url: "https://example.com/", external: true },
    { url: "http://example.com/", external: true },
    { url: "https://music.youtube.com.evil.example/", external: true },
    { url: "file://music.youtube.com/test" },
    { url: "custom-scheme://example/action" },
    { url: "javascript:alert(1)" },
    { url: "data:text/html,hello" },
    { url: "not a URL" },
];

for (const entry of ["window-open", "will-navigate", "will-redirect"]) {
    for (const { url, internal = false, external = false } of cases) {
        test(`${entry} applies the URL policy to ${url}`, async () => {
            const main = loadMain({ tunnelAvailable: true });
            await main.start();
            const window = main.windows[0];

            if (entry === "window-open") {
                const result = window.windowOpenHandler({ url });
                assert.equal(result.action, internal ? "allow" : "deny");
            } else {
                let prevented = false;
                window.webContents.emit(entry, {
                    url,
                    isSameDocument: false,
                    isMainFrame: true,
                    frame: null,
                    initiator: null,
                    preventDefault() {
                        prevented = true;
                    },
                }, url, false, true, 10, 20);
                assert.equal(prevented, !internal);
            }

            assert.deepEqual(main.externalUrls, external ? [url] : []);
        });
    }
}

for (const { url } of cases) {
    test(`does not intercept a subframe redirect to ${url}`, async () => {
        const main = loadMain({ tunnelAvailable: true });
        await main.start();
        let prevented = false;

        main.windows[0].webContents.emit("will-redirect", {
            url,
            isSameDocument: false,
            isMainFrame: false,
            frame: null,
            initiator: null,
            preventDefault() {
                prevented = true;
            },
        }, url, false, false, 10, 21);

        assert.equal(prevented, false);
        assert.deepEqual(main.externalUrls, []);
    });
}
