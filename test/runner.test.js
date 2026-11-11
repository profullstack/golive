import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, missing } from "../src/config.js";
import { channelPlayer, channelStream } from "../src/nixamp.js";
import { decoderArgs } from "../src/pairux.js";
import { plan, readState, run, summary } from "../src/runner.js";
import { parseArgs } from "../src/cli.js";

const env = (extra = {}) => ({
  HOME: "/nonexistent",
  GOLIVE_CONFIG: "/nonexistent/config.json",
  GOLIVE_NIXAMP_SERVER: "https://server2.test:4321/",
  GOLIVE_NIXAMP_CONTROL_KEY: "CTRL",
  GOLIVE_NIXAMP_LISTEN_KEY: "LISTEN",
  GOLIVE_SCHOOL_TOKEN: "nxt_token",
  ...extra,
});

test("config: env fills it, and a target with a missing key is skipped with a reason", () => {
  const config = loadConfig(env());
  assert.equal(config.nixamp.server, "https://server2.test:4321");
  assert.equal(config.nixamp.guide, "https://server2.test:4321");
  assert.equal(missing(config, "nixamp"), "");
  assert.equal(missing(config, "school"), "");
  assert.match(missing(config, "pairux"), /agentKey/);
  const { run: targets, skipped } = plan(config, []);
  assert.deepEqual(targets, ["nixamp", "school"]);
  assert.ok(skipped.pairux);
  assert.deepEqual(plan(config, ["school"]).run, ["school"]);
});

test("published links carry only the listen key", () => {
  const config = loadConfig(env());
  assert.equal(channelStream(config, "link-abc"), "https://server2.test:4321/api/channels/link-abc?k=LISTEN");
  const player = new URL(channelPlayer(config, "link-abc"));
  assert.equal(player.origin, "https://nixamp.com");
  assert.equal(player.searchParams.get("url"), "https://server2.test:4321/view/LISTEN");
  assert.equal(player.searchParams.get("play"), "channel:link-abc");
  assert.ok(!player.href.includes("CTRL"));
});

test("decoder paces a file but not a live feed, and reconnects only over http", () => {
  assert.ok(decoderArgs("https://x/a.mp3").includes("-re"));
  assert.ok(!decoderArgs("https://x/live", { live: true }).includes("-re"));
  assert.ok(decoderArgs("https://x/a.mp3").includes("-reconnect"));
  assert.ok(!decoderArgs("/tmp/a.mp3").includes("-reconnect"));
});

test("args", () => {
  const args = parseArgs(["start", "https://x/a.mp3", "--title", "Ep 1", "--only", "nixamp,pairux", "--live"]);
  assert.deepEqual(args._, ["start", "https://x/a.mp3"]);
  assert.equal(args.title, "Ep 1");
  assert.deepEqual(args.only, ["nixamp", "pairux"]);
  assert.equal(args.live, true);
  assert.throws(() => parseArgs(["start", "--only", "youtube"]), /unknown target/);
});

test("run: on nixamp, live.streaming and backtoschool, then down everywhere when the channel ends", async () => {
  const state = mkdtempSync(join(tmpdir(), "golive-test-"));
  const calls = [];
  let polls = 0;
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${pathname}`);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (pathname === "/api/links/play") {
      assert.equal(init.headers["x-nixamp-key"], "CTRL");
      assert.equal(JSON.parse(init.body).live, true);
      return reply({ channel: "link-abc" });
    }
    if (pathname === "/api/channels/link-abc" && method === "PATCH") return reply({ ok: true });
    if (pathname === "/api/channels/link-abc" && method === "DELETE") return reply({ ok: true });
    if (pathname === "/api/v1/guide/rooms") {
      const body = JSON.parse(init.body);
      assert.equal(body.basis, "owned");
      assert.equal(body.agree, true);
      assert.ok(!body.play.includes("CTRL"));
      return reply({ room: { id: "r1" }, page: "https://live.streaming.pit.world/room/ep-1" });
    }
    if (pathname === "/api/v1/guide/rooms/r1") return reply({ removed: "r1" });
    if (pathname === "/api/v1/events" && method === "POST") {
      assert.equal(init.headers.authorization, "Bearer nxt_token");
      return reply({ event: { id: "e1", slug: "ep-1", version: 1 } });
    }
    if (pathname === "/api/v1/events/e1/start") return reply({ event: { id: "e1", slug: "ep-1", version: 2, status: "live" } });
    if (pathname === "/api/v1/events/e1" && method === "GET") return reply({ event: { id: "e1", version: 2, status: "live" } });
    if (pathname === "/api/v1/events/e1/end") return reply({ event: { id: "e1", status: "ended" } });
    if (pathname === "/api/channels") {
      polls += 1;
      return reply({ channels: polls < 2 ? [{ id: "link-abc", live: false }] : [{ id: "link-abc", live: false, ended: Date.now() }] });
    }
    return reply({ error: "unexpected" }, 500);
  };
  try {
    const e = env({ GOLIVE_STATE: state });
    const config = loadConfig(e);
    const lines = [];
    // Poll quickly: the runner's 30 s waits are cut short by a fake timer-free signal.
    const result = await withFastTimers(() => run(config, { id: "t1", url: "https://cdn.test/ep1.mp3", title: "Ep 1" }, { env: e, log: (l) => lines.push(l), fetcher }));
    assert.equal(result.status, "ended", lines.join("\n"));
    assert.deepEqual(result.errors, {});
    assert.equal(result.class.page, "https://backtoschool.help/live/ep-1");
    assert.equal(readState("t1", e).status, "ended");
    assert.ok(polls >= 2, "an mp3 channel (live: false) is on the air until it has ended");
    assert.ok(calls.includes("POST /api/v1/events/e1/end"));
    assert.ok(calls.includes("DELETE /api/v1/guide/rooms/r1"));
    assert.ok(calls.includes("DELETE /api/channels/link-abc"));
    const text = summary(result);
    assert.match(text, /live\.streaming\s+https:\/\/live\.streaming\.pit\.world\/room\/ep-1/);
    assert.match(text, /skipped pairux/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("run: a failed class does not stop the stream", async () => {
  const state = mkdtempSync(join(tmpdir(), "golive-test-"));
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (pathname === "/api/links/play") return reply({ channel: "link-x" });
    if (pathname === "/api/v1/events") return reply({ error: "sign in" }, 401);
    if (pathname === "/api/channels") return reply({ channels: [] });
    return reply({ ok: true, room: { id: "r" }, page: "p" });
  };
  try {
    const e = env({ GOLIVE_STATE: state });
    const result = await withFastTimers(() => run(loadConfig(e), { id: "t2", url: "https://cdn.test/x.mp3", title: "X" }, { env: e, log: () => {}, fetcher }));
    assert.equal(result.status, "ended");
    assert.match(result.errors.school, /401/);
    assert.equal(result.nixamp.channel, "link-x");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

/** Runs `fn` with setTimeout shortened to ~0, so the runner's polling waits pass at once. */
async function withFastTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...rest) => real(cb, ms > 60_000 ? ms : 1, ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}
