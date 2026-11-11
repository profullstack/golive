/**
 * One go-live, start to finish: put the link on every target, hold it there
 * while it plays, then take it down everywhere.
 *
 * Each target fails on its own: a refused class never stops the stream, and
 * what went wrong is kept in the run's state file next to what went right.
 * The state file never holds a key or a token, only public addresses.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TARGETS, missing, stateDir } from "./config.js";
import * as nixamp from "./nixamp.js";
import * as pairux from "./pairux.js";

const HEARTBEAT_MS = 30_000;
const POLL_MS = 30_000;

export const newId = () => `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;

export function statePath(id, env = process.env) {
  return join(stateDir(env), `${id}.json`);
}

export function saveState(state, env = process.env) {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const path = statePath(state.id, env);
  writeFileSync(`${path}.part`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.part`, path);
}

export function readState(id, env = process.env) {
  try {
    return JSON.parse(readFileSync(statePath(id, env), "utf8"));
  } catch {
    return null;
  }
}

export function listStates(env = process.env) {
  let names = [];
  try {
    names = readdirSync(stateDir(env)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((name) => readState(name.slice(0, -5), env)).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
}

/** Which targets this run tries, and why the others are skipped. */
export function plan(config, only) {
  const wanted = only?.length ? TARGETS.filter((one) => only.includes(one)) : TARGETS;
  const run = [];
  const skipped = {};
  for (const target of wanted) {
    const why = missing(config, target);
    if (why) skipped[target] = why;
    else run.push(target);
  }
  return { run, skipped };
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Runs a go-live in this process until it is over. `opts`: id, url, title,
 * description, live, only, ffmpeg, maxHours. Returns the final state.
 */
export async function run(config, opts, { env = process.env, log = console.log, signal, fetcher = fetch } = {}) {
  const { run: targets, skipped } = plan(config, opts.only);
  const state = {
    id: opts.id ?? newId(),
    pid: process.pid,
    url: opts.url,
    title: opts.title,
    live: Boolean(opts.live),
    startedAt: Date.now(),
    status: "starting",
    skipped,
    errors: {},
  };
  const save = () => saveState(state, env);
  const fail = (target, error) => {
    state.errors[target] = String(error?.message ?? error);
    log(`${target}: ${state.errors[target]}`);
  };
  save();

  // nixamp first: the room and the class both point at its channel.
  if (targets.includes("nixamp")) {
    try {
      state.nixamp = await nixamp.goLive(config, { url: opts.url, title: opts.title }, fetcher);
      log(`nixamp: on the air as channel ${state.nixamp.channel}`);
      try {
        state.room = await nixamp.publishRoom(config, { channel: state.nixamp.channel, title: opts.title, note: opts.description }, fetcher);
        log(`live.streaming: ${state.room.page}`);
      } catch (error) {
        fail("live.streaming", error);
      }
    } catch (error) {
      fail("nixamp", error);
    }
  }
  if (targets.includes("school") && state.nixamp) {
    try {
      state.class = await nixamp.startClass(config, { channel: state.nixamp.channel, title: opts.title, description: opts.description }, fetcher);
      log(`backtoschool.help: ${state.class.page}`);
    } catch (error) {
      fail("school", error);
    }
  }
  let broadcast = null;
  if (targets.includes("pairux")) {
    try {
      broadcast = await pairux.openBroadcast(config, { title: opts.title, description: opts.description }, fetcher);
      state.pairux = { sessionId: broadcast.sessionId, joinCode: broadcast.joinCode, liveUrl: broadcast.liveUrl, channelUrl: broadcast.channelUrl };
      log(`pairux: ${broadcast.liveUrl}`);
    } catch (error) {
      fail("pairux", error);
    }
  }
  const anything = state.nixamp || broadcast;
  state.status = anything ? "live" : "failed";
  save();
  if (!anything) return state;

  // Hold it on the air.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = Date.now() + (opts.maxHours ?? (opts.live ? 6 : 4)) * 3_600_000;
  const cap = setTimeout(() => stop.abort(), Math.max(0, deadline - Date.now()));

  const holds = [];
  if (broadcast) {
    const beat = setInterval(() => {
      pairux.heartbeat(config, broadcast.sessionId, fetcher).catch((error) => log(`pairux: heartbeat failed: ${error.message}`));
    }, HEARTBEAT_MS);
    holds.push(
      pairux.publish(broadcast, opts.url, { live: opts.live, ffmpeg: opts.ffmpeg, signal: stop.signal, log })
        .then((seconds) => log(`pairux: sent ${Math.round(seconds)} s`))
        .catch((error) => fail("pairux", error))
        .finally(() => clearInterval(beat)),
    );
  }
  if (state.nixamp && opts.live) {
    // A live feed: nixamp keeps redialling one that stopped, so the end is the
    // feed itself going away (twice in a row, to ride out a blip).
    holds.push((async () => {
      let gone = 0;
      while (!stop.signal.aborted && gone < 2) {
        await sleep(POLL_MS, stop.signal);
        gone = (await pairux.reachable(opts.url)) ? 0 : gone + 1;
      }
      log("nixamp: the live feed ended");
    })());
  } else if (state.nixamp) {
    holds.push((async () => {
      // A link channel plays its outro once the media ends; that is the end.
      await sleep(POLL_MS, stop.signal);
      let unknown = 0;
      while (!stop.signal.aborted) {
        const on = await nixamp.channelLive(config, state.nixamp.channel, fetcher);
        if (on === false) break;
        unknown = on === null ? unknown + 1 : 0;
        if (unknown >= 20) break; // the server has been unreachable for ten minutes
        await sleep(POLL_MS, stop.signal);
      }
      log("nixamp: the channel finished");
    })());
  }
  await Promise.all(holds);
  clearTimeout(cap);
  signal?.removeEventListener("abort", onAbort);

  // Take it down everywhere.
  state.status = "ending";
  save();
  await Promise.all([
    broadcast && pairux.closeBroadcast(config, broadcast.sessionId, fetcher).catch((error) => fail("pairux end", error)),
    state.class && nixamp.endClass(config, state.class.id, fetcher).catch((error) => fail("school end", error)),
    state.room && nixamp.removeRoom(config, state.room.id, fetcher).catch((error) => fail("live.streaming end", error)),
    state.nixamp && nixamp.takeOff(config, state.nixamp.channel, fetcher).catch((error) => fail("nixamp end", error)),
  ]);
  state.status = "ended";
  state.endedAt = Date.now();
  save();
  log("ended everywhere");
  return state;
}

/** The public addresses of a run, one per line. */
export function summary(state) {
  const lines = [];
  if (state.nixamp) lines.push(`nixamp            ${state.nixamp.player}`);
  if (state.room?.page) lines.push(`live.streaming    ${state.room.page}`);
  if (state.class?.page) lines.push(`backtoschool.help ${state.class.page}`);
  if (state.pairux) lines.push(`pairux            ${state.pairux.liveUrl}  (${state.pairux.channelUrl})`);
  for (const [target, why] of Object.entries(state.skipped ?? {})) lines.push(`skipped ${target}: ${why}`);
  for (const [target, why] of Object.entries(state.errors ?? {})) lines.push(`failed ${target}: ${why}`);
  return lines.join("\n");
}
