import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig, stateDir, TARGETS } from "./config.js";
import { listStates, newId, plan, readState, run, saveState, summary } from "./runner.js";

const HELP = `golive: put a recording or a live audio feed on the air everywhere at once.

  golive start URL --title T [--description D] [--live] [--only nixamp,school,pairux] [--json]
      go live in the background and print where it plays; the run takes itself
      down when the audio ends. --wait holds the terminal until then.
  golive run URL --title T ...     the same, in the foreground
  golive list                      runs, newest first
  golive status ID                 one run's state
  golive stop ID                   end a run now, everywhere
  golive check                     which targets the config can reach

URL is anything ffmpeg reads: an mp3 or m4a link, an HLS or Icecast stream.
--live marks a feed that is live itself (no pacing, redial on a drop).

Targets: nixamp (a live channel on your nixamp server, listed as a room on
live.streaming), school (a live class on backtoschool.help playing that
channel) and pairux (a live on a PairUX channel). Keys live in
${configPath()} (chmod 600); see the README.
`;

export function parseArgs(argv) {
  const out = { _: [], only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--title" || arg === "-t") out.title = value();
    else if (arg === "--description" || arg === "-d") out.description = value();
    else if (arg === "--only") out.only = value().split(",").map((one) => one.trim()).filter(Boolean);
    else if (arg === "--id") out.id = value();
    else if (arg === "--ffmpeg") out.ffmpeg = value();
    else if (arg === "--max-hours") out.maxHours = Number(value());
    else if (arg === "--live") out.live = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--wait") out.wait = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else out._.push(arg);
  }
  for (const one of out.only) if (!TARGETS.includes(one)) throw new Error(`unknown target ${one} (${TARGETS.join(", ")})`);
  return out;
}

function runOptions(args) {
  const url = args._[1];
  if (!url) throw new Error("give the audio URL");
  if (!args.title) throw new Error("--title is required");
  return { id: args.id, url, title: args.title, description: args.description, live: args.live, only: args.only, ffmpeg: args.ffmpeg, maxHours: args.maxHours };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const config = loadConfig();

  if (command === "check") {
    const { run: ok, skipped } = plan(config, args.only);
    for (const one of ok) console.log(`ready   ${one}`);
    for (const [one, why] of Object.entries(skipped)) console.log(`skipped ${one}: ${why}`);
    return ok.length ? 0 : 1;
  }

  if (command === "run") {
    const opts = runOptions(args);
    const stop = new AbortController();
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(sig, () => stop.abort());
    const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
    const state = await run(config, opts, { signal: stop.signal, log });
    return state.status === "failed" ? 1 : 0;
  }

  if (command === "start") {
    const opts = runOptions(args);
    // The same link already on the air (a hook that fired twice): say where, do not air it twice.
    const already = listStates().find((one) => one.url === opts.url && ["starting", "live"].includes(one.status) && alive(one.pid));
    if (already) {
      console.log(`golive ${already.id} is already ${already.status} with that link\n${summary(already)}`);
      return 0;
    }
    const id = opts.id ?? newId();
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const logFile = join(stateDir(), `${id}.log`);
    const fd = openSync(logFile, "a", 0o600);
    const bin = fileURLToPath(new URL("../bin/golive.js", import.meta.url));
    const child = spawn(process.execPath, [bin, "run", ...argv.slice(1), "--id", id], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.unref();
    // Wait for the run to be on the air (or to have failed) before answering.
    const until = Date.now() + 150_000;
    let state = null;
    while (Date.now() < until) {
      await sleep(1_000);
      state = readState(id);
      if (state && state.status !== "starting") break;
      if (child.exitCode !== null) break;
    }
    if (!state || state.status === "starting") {
      console.error(`golive ${id}: still starting after 150 s; see ${logFile}`);
      return 1;
    }
    if (args.json) console.log(JSON.stringify({ ...state, log: logFile }, null, 2));
    else console.log(`golive ${id} ${state.status} (log ${logFile})\n${summary(state)}`);
    if (args.wait) {
      while (!["ended", "failed"].includes(readState(id)?.status)) await sleep(5_000);
    }
    return state.status === "failed" ? 1 : 0;
  }

  if (command === "list") {
    for (const state of listStates()) {
      console.log(`${state.id}  ${state.status.padEnd(8)}  ${new Date(state.startedAt).toISOString()}  ${state.title}`);
    }
    return 0;
  }

  if (command === "status" || command === "stop") {
    const id = args._[1];
    const state = id && readState(id);
    if (!state) {
      console.error(`no run ${id ?? ""}`);
      return 1;
    }
    if (command === "status") {
      console.log(args.json ? JSON.stringify(state, null, 2) : `${state.id} ${state.status}  ${state.title}\n${summary(state)}`);
      return 0;
    }
    if (["ended", "failed"].includes(state.status)) {
      console.log(`${id} already ${state.status}`);
      return 0;
    }
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      state.status = "ended";
      saveState(state);
      console.log(`${id}: its process was gone; marked ended (take it down by hand if anything is still up)`);
      return 0;
    }
    for (let i = 0; i < 60 && !["ended", "failed"].includes(readState(id)?.status); i += 1) await sleep(1_000);
    console.log(`${id} ${readState(id)?.status}`);
    return 0;
  }

  console.error(`unknown command ${command}\n`);
  process.stdout.write(HELP);
  return 2;
}
