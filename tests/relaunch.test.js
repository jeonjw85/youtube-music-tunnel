const assert = require("node:assert/strict");
const test = require("node:test");
const { loadMain } = require("./helpers/main-harness");

test("continuing without a tunnel disables the proxy in the relaunched environment", async () => {
    const main = loadMain({ env: { YTM_USE_PROXY: "true", UNRELATED: "keep" } });

    await main.start();

    assert.equal(main.relaunches.length, 1);
    assert.equal(main.relaunches[0].env.YTM_USE_PROXY, "false");
    assert.equal(main.relaunches[0].env.UNRELATED, "keep");
    assert.equal(main.relaunches[0].options, undefined);
    assert.equal(main.quitCount, 1);
});

for (const useProxy of [true, false]) {
    test(`changing useProxy from ${useProxy} clears environment overrides before relaunch`, () => {
        const main = loadMain({
            useProxy,
            env: {
                YTM_USE_PROXY: String(useProxy),
                YTM_MINIMIZE_TO_TRAY: "true",
                YTM_START_HIDDEN: "true",
                UNRELATED: "keep",
            },
        });

        const result = main.handlers.get("settings:set")({}, { useProxy: !useProxy });

        assert.equal(result.useProxy, !useProxy);
        assert.equal(result.relaunching, true);
        assert.equal(main.relaunches.length, 1);
        assert.deepEqual(main.relaunches[0].env, { UNRELATED: "keep" });
        assert.equal(main.relaunches[0].options, undefined);
        assert.equal(main.quitCount, 1);
    });
}
