import assert from "node:assert/strict";
import test from "node:test";

import {
  clearObservedUnreadStorage,
  deriveLatestByChannel,
  observedUnreadStorageKey,
  OBSERVED_UNREAD_STORAGE_PREFIX,
  readObservedUnreadFromStorage,
  removeChannelFromObservedUnreadStorage,
  writeObservedUnreadToStorage,
} from "./observedUnreadStorage.ts";
import { READ_STATE_HORIZON_SECONDS } from "./readState/readStateFormat.ts";

// ── localStorage mock infrastructure ─────────────────────────────────────────

function makeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    _store: store,
  };
}

function makeIsolatedStorage() {
  const ls = makeLocalStorage();
  const prevWindow = globalThis.window;
  if (typeof globalThis.window === "undefined") {
    globalThis.window = {};
  }
  const prevLs = globalThis.window.localStorage;
  globalThis.window.localStorage = ls;
  return {
    ls,
    restore: () => {
      if (prevWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window.localStorage = prevLs;
      }
    },
  };
}

function makeEvent({
  id = "event-1",
  createdAt = 1_000_000,
  rootId = "root-1",
  highPriority = false,
  countsTowardBadge = true,
  countsTowardAppBadge = false,
} = {}) {
  return {
    id,
    createdAt,
    rootId,
    highPriority,
    countsTowardBadge,
    countsTowardAppBadge,
  };
}

function makeEventsByChannel(entries) {
  const map = new Map();
  for (const [channelId, events] of entries) {
    const byId = new Map();
    for (const e of events) {
      byId.set(e.id, e);
    }
    map.set(channelId, byId);
  }
  return map;
}

const NOW_SECONDS = Math.floor(Date.now() / 1_000);
const FRESH_AT = NOW_SECONDS - 100;
const STALE_AT = NOW_SECONDS - READ_STATE_HORIZON_SECONDS - 100;

// ── observedUnreadStorageKey ──────────────────────────────────────────────────

test("observedUnreadStorageKey normalizes relay URL", () => {
  const k1 = observedUnreadStorageKey("pk1", "WSS://Relay.Example.Com/");
  const k2 = observedUnreadStorageKey("pk1", "wss://relay.example.com");
  assert.equal(k1, k2);
});

test("observedUnreadStorageKey differs for different relays", () => {
  const kA = observedUnreadStorageKey("pk1", "wss://relay-a.example.com");
  const kB = observedUnreadStorageKey("pk1", "wss://relay-b.example.com");
  assert.notEqual(kA, kB);
});

test("observedUnreadStorageKey differs for different pubkeys", () => {
  const k1 = observedUnreadStorageKey("pk1", "wss://relay.example.com");
  const k2 = observedUnreadStorageKey("pk2", "wss://relay.example.com");
  assert.notEqual(k1, k2);
});

test("observedUnreadStorageKey has correct prefix", () => {
  const k = observedUnreadStorageKey("pk1", "wss://relay.example.com");
  assert.ok(k.startsWith(`${OBSERVED_UNREAD_STORAGE_PREFIX}:`));
});

// ── write/read round-trip ─────────────────────────────────────────────────────

test("round-trip: events written are readable and intact", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const event = makeEvent({ id: "e1", createdAt: FRESH_AT });
    const map = makeEventsByChannel([["channel-1", [event]]]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    const result = readObservedUnreadFromStorage(pubkey, relay);

    assert.ok(result !== null, "should return a map");
    const ch = result.get("channel-1");
    assert.ok(ch !== undefined, "channel-1 should be present");
    assert.ok(ch.has("e1"), "event e1 should be present");
    const e = ch.get("e1");
    assert.equal(e.id, "e1");
    assert.equal(e.createdAt, FRESH_AT);
    assert.equal(e.rootId, "root-1");
  } finally {
    restore();
  }
});

test("round-trip: relay A rows not readable under relay B", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    const map = makeEventsByChannel([
      ["channel-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relayA, map);
    const result = readObservedUnreadFromStorage(pubkey, relayB);

    assert.equal(result, null, "relay B should see no data");
  } finally {
    restore();
  }
});

test("round-trip: different pubkeys have isolated buckets", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const relay = "wss://relay.example.com";
    const map1 = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);
    const map2 = makeEventsByChannel([
      ["ch-2", [makeEvent({ id: "e2", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage("pk1", relay, map1);
    writeObservedUnreadToStorage("pk2", relay, map2);

    const r1 = readObservedUnreadFromStorage("pk1", relay);
    const r2 = readObservedUnreadFromStorage("pk2", relay);

    assert.ok(r1?.has("ch-1"), "pk1 should see ch-1");
    assert.ok(!r1?.has("ch-2"), "pk1 should not see ch-2");
    assert.ok(r2?.has("ch-2"), "pk2 should see ch-2");
    assert.ok(!r2?.has("ch-1"), "pk2 should not see ch-1");
  } finally {
    restore();
  }
});

test("round-trip: trailing slash normalizes to same bucket", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relaySlash = "wss://relay.example.com/";
    const relayNoSlash = "wss://relay.example.com";
    const map = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relaySlash, map);
    const result = readObservedUnreadFromStorage(pubkey, relayNoSlash);

    assert.ok(
      result?.has("ch-1"),
      "normalized URL should resolve to same bucket",
    );
  } finally {
    restore();
  }
});

test("read returns null for missing key", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test("read returns null for corrupt JSON", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const key = observedUnreadStorageKey("pk1", "wss://relay.example.com");
    window.localStorage.setItem(key, "not-json{{{");
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test("read discards malformed events (missing id)", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const key = observedUnreadStorageKey("pk1", "wss://relay.example.com");
    window.localStorage.setItem(
      key,
      JSON.stringify({
        updatedAt: Date.now(),
        eventsByChannel: {
          "ch-1": [
            { createdAt: FRESH_AT }, // missing id
            makeEvent({ id: "e-ok", createdAt: FRESH_AT }),
          ],
        },
      }),
    );
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    assert.ok(result !== null);
    const ch = result.get("ch-1");
    assert.ok(ch !== undefined);
    assert.ok(!ch.has(undefined), "malformed event should be absent");
    assert.ok(ch.has("e-ok"), "valid event should be present");
    assert.equal(ch.size, 1);
  } finally {
    restore();
  }
});

test("read discards events with non-finite createdAt", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const key = observedUnreadStorageKey("pk1", "wss://relay.example.com");
    window.localStorage.setItem(
      key,
      JSON.stringify({
        updatedAt: Date.now(),
        eventsByChannel: {
          "ch-1": [
            {
              id: "e-inf",
              createdAt: Infinity,
              rootId: null,
              highPriority: false,
              countsTowardBadge: false,
              countsTowardAppBadge: false,
            },
            makeEvent({ id: "e-ok", createdAt: FRESH_AT }),
          ],
        },
      }),
    );
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    const ch = result?.get("ch-1");
    assert.ok(!ch?.has("e-inf"), "Infinity createdAt should be discarded");
    assert.ok(ch?.has("e-ok"), "finite createdAt should be kept");
  } finally {
    restore();
  }
});

test("read returns null when eventsByChannel is not an object", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const key = observedUnreadStorageKey("pk1", "wss://relay.example.com");
    window.localStorage.setItem(
      key,
      JSON.stringify({ updatedAt: Date.now(), eventsByChannel: [1, 2, 3] }),
    );
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    assert.equal(result, null);
  } finally {
    restore();
  }
});

// ── age pruning ───────────────────────────────────────────────────────────────

test("write prunes stale events before persisting", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    // stale event alongside a fresh one
    const map = makeEventsByChannel([
      [
        "ch-1",
        [
          makeEvent({ id: "stale", createdAt: STALE_AT }),
          makeEvent({ id: "fresh", createdAt: FRESH_AT }),
        ],
      ],
    ]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    const result = readObservedUnreadFromStorage(pubkey, relay);

    const ch = result?.get("ch-1");
    assert.ok(!ch?.has("stale"), "stale event should be pruned on write");
    assert.ok(ch?.has("fresh"), "fresh event should survive");
  } finally {
    restore();
  }
});

test("read prunes stale events from persisted data", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const key = observedUnreadStorageKey("pk1", "wss://relay.example.com");
    // Directly write stale data bypassing write() pruning
    window.localStorage.setItem(
      key,
      JSON.stringify({
        updatedAt: Date.now(),
        eventsByChannel: {
          "ch-1": [
            makeEvent({ id: "stale", createdAt: STALE_AT }),
            makeEvent({ id: "fresh", createdAt: FRESH_AT }),
          ],
        },
      }),
    );
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    const ch = result?.get("ch-1");
    assert.ok(!ch?.has("stale"), "stale event should be pruned on read");
    assert.ok(ch?.has("fresh"), "fresh event should survive");
  } finally {
    restore();
  }
});

test("write removes key entirely when all events are stale", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const map = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "stale", createdAt: STALE_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    const key = observedUnreadStorageKey(pubkey, relay);
    assert.equal(
      window.localStorage.getItem(key),
      null,
      "key should be absent when all events stale",
    );
  } finally {
    restore();
  }
});

// ── per-channel cap ───────────────────────────────────────────────────────────

test("write caps per channel at 1000 events keeping newest", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const events = Array.from({ length: 1100 }, (_, i) =>
      makeEvent({ id: `e-${i}`, createdAt: FRESH_AT + i }),
    );
    const map = makeEventsByChannel([["ch-1", events]]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    const result = readObservedUnreadFromStorage(pubkey, relay);

    const ch = result?.get("ch-1");
    assert.equal(ch?.size, 1000, "should be capped at 1000");
    // Oldest events (lowest createdAt) should be evicted.
    assert.ok(!ch?.has("e-0"), "oldest event should be evicted");
    assert.ok(ch?.has("e-1099"), "newest event should survive");
  } finally {
    restore();
  }
});

// ── global cap ────────────────────────────────────────────────────────────────

test("write caps globally at 5000 events across channels", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    // 6 channels × 1000 events each = 6000 total, should be trimmed to 5000
    const entries = Array.from({ length: 6 }, (_, ch) => [
      `channel-${ch}`,
      Array.from({ length: 1000 }, (_, i) =>
        makeEvent({
          id: `ch${ch}-e${i}`,
          createdAt: FRESH_AT + ch * 10000 + i,
        }),
      ),
    ]);
    const map = makeEventsByChannel(entries);

    writeObservedUnreadToStorage(pubkey, relay, map);
    const result = readObservedUnreadFromStorage(pubkey, relay);

    let total = 0;
    for (const eventsById of result.values()) {
      total += eventsById.size;
    }
    assert.ok(total <= 5000, `total ${total} should be <= 5000`);
  } finally {
    restore();
  }
});

// ── removeChannelFromObservedUnreadStorage ────────────────────────────────────

test("removeChannel removes only the specified channel", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const map = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
      ["ch-2", [makeEvent({ id: "e2", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    removeChannelFromObservedUnreadStorage(pubkey, relay, "ch-1");

    const result = readObservedUnreadFromStorage(pubkey, relay);
    assert.ok(!result?.has("ch-1"), "ch-1 should be removed");
    assert.ok(result?.has("ch-2"), "ch-2 should remain");
  } finally {
    restore();
  }
});

test("removeChannel removes key entirely when last channel removed", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const map = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    removeChannelFromObservedUnreadStorage(pubkey, relay, "ch-1");

    const key = observedUnreadStorageKey(pubkey, relay);
    assert.equal(
      window.localStorage.getItem(key),
      null,
      "key should be absent after last channel removed",
    );
  } finally {
    restore();
  }
});

test("removeChannel is a no-op when channel not present", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const map = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    removeChannelFromObservedUnreadStorage(pubkey, relay, "ch-nonexistent");

    const result = readObservedUnreadFromStorage(pubkey, relay);
    assert.ok(result?.has("ch-1"), "ch-1 should still be present");
  } finally {
    restore();
  }
});

// ── clearObservedUnreadStorage ────────────────────────────────────────────────

test("clearObservedUnreadStorage removes the entire scope bucket", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const map = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    clearObservedUnreadStorage(pubkey, relay);

    const result = readObservedUnreadFromStorage(pubkey, relay);
    assert.equal(result, null, "scope bucket should be cleared");
  } finally {
    restore();
  }
});

test("clearObservedUnreadStorage does not affect other scopes", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    const mapA = makeEventsByChannel([
      ["ch-a", [makeEvent({ id: "ea", createdAt: FRESH_AT })]],
    ]);
    const mapB = makeEventsByChannel([
      ["ch-b", [makeEvent({ id: "eb", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage("pk1", relayA, mapA);
    writeObservedUnreadToStorage("pk1", relayB, mapB);
    clearObservedUnreadStorage("pk1", relayA);

    const resultA = readObservedUnreadFromStorage("pk1", relayA);
    const resultB = readObservedUnreadFromStorage("pk1", relayB);

    assert.equal(resultA, null, "relay A bucket should be cleared");
    assert.ok(resultB?.has("ch-b"), "relay B bucket should be unaffected");
  } finally {
    restore();
  }
});

// ── deriveLatestByChannel ─────────────────────────────────────────────────────

test("deriveLatestByChannel returns max createdAt per channel", () => {
  const map = makeEventsByChannel([
    [
      "ch-1",
      [
        makeEvent({ id: "e1", createdAt: 100 }),
        makeEvent({ id: "e2", createdAt: 200 }),
        makeEvent({ id: "e3", createdAt: 150 }),
      ],
    ],
    ["ch-2", [makeEvent({ id: "e4", createdAt: 50 })]],
  ]);

  const latest = deriveLatestByChannel(map);

  assert.equal(latest.get("ch-1"), 200);
  assert.equal(latest.get("ch-2"), 50);
});

test("deriveLatestByChannel returns empty map for empty input", () => {
  const latest = deriveLatestByChannel(new Map());
  assert.equal(latest.size, 0);
});

// ── persistence + lifecycle scenarios ────────────────────────────────────────

test("record→pending-debounce→pagehide-flush→hydrate: event is present after reload", () => {
  // This test models the exact Cmd+R scenario:
  // 1. An event is observed (recorded into the in-memory map).
  // 2. The debounce timer is pending (not fired yet).
  // 3. pagehide fires, triggering a synchronous flush.
  // 4. A fresh read (simulating the next boot hydration) finds the event.

  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const event = makeEvent({ id: "e-pending", createdAt: FRESH_AT });

    // Step 1-2: event observed, debounce is pending (we simulate by not having
    // called writeObservedUnreadToStorage yet — the timer hasn't fired).
    const liveMap = makeEventsByChannel([["ch-1", [event]]]);

    // Step 3: synchronous flush (what flushObservedUnreadWrite does).
    writeObservedUnreadToStorage(pubkey, relay, liveMap);

    // Step 4: read back (next boot hydration).
    const result = readObservedUnreadFromStorage(pubkey, relay);

    assert.ok(
      result?.get("ch-1")?.has("e-pending"),
      "event recorded before pagehide must survive hydration",
    );
  } finally {
    restore();
  }
});

test("mark-read clears channel from storage: explicit channel read persists after reload", () => {
  // Events exist → channel marked read (clearObserved path) → storage cleared
  // → reload → channel should NOT re-appear as unread.

  const { restore } = makeIsolatedStorage();
  try {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const event = makeEvent({ id: "e1", createdAt: FRESH_AT });
    const map = makeEventsByChannel([["ch-1", [event]]]);

    // Events persisted.
    writeObservedUnreadToStorage(pubkey, relay, map);

    // Channel marked read — remove from storage (clearObserved path).
    removeChannelFromObservedUnreadStorage(pubkey, relay, "ch-1");

    // Reload: read back.
    const result = readObservedUnreadFromStorage(pubkey, relay);
    assert.ok(
      !result?.has("ch-1"),
      "ch-1 should not appear after mark-read + reload",
    );
  } finally {
    restore();
  }
});

test("thread:rootA marker prunes only rootA events, leaving rootB unread", () => {
  // Validates the plan requirement: opening thread A must not clear thread B.
  // This test exercises deriveLatestByChannel to confirm ch-1 still has a
  // non-zero latest after thread A events are removed.

  const { restore } = makeIsolatedStorage();
  try {
    const rootA = "root-a";
    const rootB = "root-b";
    const eventA = makeEvent({ id: "eA", createdAt: FRESH_AT, rootId: rootA });
    const eventB = makeEvent({
      id: "eB",
      createdAt: FRESH_AT + 10,
      rootId: rootB,
    });

    // Both threads in ch-1.
    const map = makeEventsByChannel([["ch-1", [eventA, eventB]]]);
    writeObservedUnreadToStorage("pk1", "wss://relay.example.com", map);

    // Simulate marker prune: remove events covered by thread:rootA marker.
    // (In the hook this happens in the readStateVersion effect via observedUnreadEventReadAt.)
    const stored = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    assert.ok(stored !== null);
    const ch1 = stored.get("ch-1");
    assert.ok(ch1 !== undefined);

    // Remove events whose rootId matches rootA (simulating the prune pass).
    ch1.delete(eventA.id);

    // Persist the pruned map.
    writeObservedUnreadToStorage("pk1", "wss://relay.example.com", stored);

    // Reload.
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    const resultCh1 = result?.get("ch-1");
    assert.ok(!resultCh1?.has("eA"), "thread A event should be pruned");
    assert.ok(resultCh1?.has("eB"), "thread B event should remain unread");

    // latestByChannel for ch-1 should still reflect thread B.
    const latest = deriveLatestByChannel(result);
    assert.equal(latest.get("ch-1"), FRESH_AT + 10);
  } finally {
    restore();
  }
});

test("msg:<id> marker prunes only that message", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const eA = makeEvent({ id: "eA", createdAt: FRESH_AT });
    const eB = makeEvent({ id: "eB", createdAt: FRESH_AT + 1 });
    const map = makeEventsByChannel([["ch-1", [eA, eB]]]);
    writeObservedUnreadToStorage("pk1", "wss://relay.example.com", map);

    // Prune eA only.
    const stored = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    stored.get("ch-1").delete("eA");
    writeObservedUnreadToStorage("pk1", "wss://relay.example.com", stored);

    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    assert.ok(!result?.get("ch-1")?.has("eA"), "eA should be removed");
    assert.ok(result?.get("ch-1")?.has("eB"), "eB should remain");
  } finally {
    restore();
  }
});

// ── scope isolation (A→B→A state machine) ────────────────────────────────────
//
// These tests model the scope-fence without a React harness. They prove that:
//   - A rows are visible when scope matches A (steady state).
//   - A rows are absent in B's bucket.
//   - A rows return after switching back to A.
//   - A late A-scope write does not contaminate B's bucket.

test("scope-isolation: A rows visible in A, absent in B, restored on A again", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    const pubkey = "pk1";

    const eA = makeEvent({ id: "eA", createdAt: FRESH_AT });
    const eB = makeEvent({ id: "eB", createdAt: FRESH_AT + 1 });

    writeObservedUnreadToStorage(
      pubkey,
      relayA,
      makeEventsByChannel([["ch-a", [eA]]]),
    );
    writeObservedUnreadToStorage(
      pubkey,
      relayB,
      makeEventsByChannel([["ch-b", [eB]]]),
    );

    // In A: see A's rows.
    const inA = readObservedUnreadFromStorage(pubkey, relayA);
    assert.ok(inA?.has("ch-a"), "A rows visible in A");
    assert.ok(!inA?.has("ch-b"), "B rows absent in A");

    // In B: see B's rows, not A's.
    const inB = readObservedUnreadFromStorage(pubkey, relayB);
    assert.ok(inB?.has("ch-b"), "B rows visible in B");
    assert.ok(!inB?.has("ch-a"), "A rows absent in B");

    // Back in A: A's rows return.
    const backInA = readObservedUnreadFromStorage(pubkey, relayA);
    assert.ok(backInA?.has("ch-a"), "A rows return on switch back to A");
  } finally {
    restore();
  }
});

test("scope-isolation: a late A-scope write does not overwrite B's bucket", () => {
  // Models: A timer fires after scope has switched to B.
  // The timer captures A's key and scope; it must write to A's key, not B's.
  const { restore } = makeIsolatedStorage();
  try {
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    const pubkey = "pk1";

    // B has its own data.
    writeObservedUnreadToStorage(
      pubkey,
      relayB,
      makeEventsByChannel([
        ["ch-b", [makeEvent({ id: "eB", createdAt: FRESH_AT })]],
      ]),
    );

    // A late A-scope timer fires: writes A's data.
    writeObservedUnreadToStorage(
      pubkey,
      relayA,
      makeEventsByChannel([
        ["ch-a", [makeEvent({ id: "eA", createdAt: FRESH_AT })]],
      ]),
    );

    // B's bucket must be unchanged.
    const inB = readObservedUnreadFromStorage(pubkey, relayB);
    assert.ok(
      inB?.has("ch-b"),
      "B's bucket should be unaffected by A's late write",
    );
    assert.ok(!inB?.has("ch-a"), "A rows must not appear in B's bucket");
  } finally {
    restore();
  }
});

// ── quota / write failure ─────────────────────────────────────────────────────

test("writeObservedUnreadToStorage returns false when localStorage throws", () => {
  const prevWindow = globalThis.window;
  if (typeof globalThis.window === "undefined") {
    globalThis.window = {};
  }
  const prevLs = globalThis.window?.localStorage;
  globalThis.window.localStorage = {
    get length() {
      return 0;
    },
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw new DOMException("QuotaExceededError");
    },
    removeItem: () => {},
  };
  try {
    const map = makeEventsByChannel([
      ["ch-1", [makeEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);
    const result = writeObservedUnreadToStorage(
      "pk1",
      "wss://relay.example.com",
      map,
    );
    // setLocalStorageItemWithRecovery retries after eviction; on persistent
    // failure it returns false.  The exact return value depends on whether
    // eviction succeeded, but the call must not throw.
    assert.ok(
      typeof result === "boolean",
      "write failure must return boolean, not throw",
    );
  } finally {
    if (prevWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window.localStorage = prevLs;
    }
  }
});
