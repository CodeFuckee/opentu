import { afterAll, expect, test } from "bun:test";
import type { ModelChannel } from "../src/stores/use-config-store";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { createH3LocalChannel, defaultConfig, ensureBuiltInChannels, selectableModelsByCapability, useConfigStore } = await import(
    "../src/stores/use-config-store"
);

test("the default config ships the built-in local H3 channel as a selectable video model", () => {
    const channel = defaultConfig.channels.find((item) => item.id === "h3-local");
    expect(channel).toBeDefined();
    expect(channel?.models).toEqual([{ name: "MiniMax-H3", capability: "video" }]);
    expect(selectableModelsByCapability(defaultConfig, "video")).toContain("h3-local::MiniMax-H3");
});

test("the built-in local H3 channel is ready without any user credentials", () => {
    expect(useConfigStore.getState().isAiConfigReady(defaultConfig, "h3-local::MiniMax-H3")).toBe(true);
});

test("ensureBuiltInChannels appends the built-in channel for configs saved before it existed", () => {
    const channels: ModelChannel[] = [defaultConfig.channels[0]];
    const ensured = ensureBuiltInChannels(channels);
    expect(ensured.some((channel) => channel.id === "h3-local")).toBe(true);
    expect(channels.some((channel) => channel.id === "h3-local")).toBe(false);
});

test("ensureBuiltInChannels does not duplicate when the id or gateway baseUrl already exists", () => {
    expect(ensureBuiltInChannels([...defaultConfig.channels]).map((channel) => channel.id)).toEqual(
        defaultConfig.channels.map((channel) => channel.id),
    );
    const renamed: ModelChannel[] = [{ ...createH3LocalChannel(), id: "my-own-h3", name: "My H3" }];
    expect(ensureBuiltInChannels(renamed)).toBe(renamed);
});

test("the built-in channel keeps the local gateway baseUrl and placeholder key", () => {
    const channel = createH3LocalChannel();
    expect(channel.baseUrl).toBe("http://10.37.80.25:8788");
    expect(channel.apiKey.trim()).not.toBe("");
    expect(channel.apiFormat).toBe("openai");
});
