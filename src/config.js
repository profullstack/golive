/**
 * Where golive reads its targets and keys.
 *
 * One JSON file, 0600, at $GOLIVE_CONFIG or ~/.config/golive/config.json.
 * Keys never come from the command line (they would show in `ps`), and the
 * environment can override any of them for a one-off run.
 *
 * {
 *   "nixamp": {
 *     "server": "https://server2.example.nixamp.com:4321", // carries the stream (needs ffmpeg)
 *     "controlKey": "...",                                 // keys.json "key" on that server
 *     "listenKey": "...",                                  // keys.json "listenKey": the public view key
 *     "guide": "https://server2.example.nixamp.com:4321",  // the live.streaming guide host (default: server)
 *     "basis": "owned"                                     // why we may broadcast it
 *   },
 *   "school": { "site": "https://backtoschool.help", "token": "<nixamp token>", "topic": "Podcasts" },
 *   "pairux": { "site": "https://pairux.com", "agentKey": "pux_ag_...", "channel": "moshcoding" }
 * }
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TARGETS = ["nixamp", "school", "pairux"];

export function configPath(env = process.env) {
  return env.GOLIVE_CONFIG || join(env.HOME || homedir(), ".config", "golive", "config.json");
}

export function stateDir(env = process.env) {
  return env.GOLIVE_STATE || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "golive");
}

const trim = (value) => String(value ?? "").trim().replace(/\/+$/, "");

/** The config with env overrides applied; missing pieces are "" (that target is then skipped). */
export function loadConfig(env = process.env, path = configPath(env)) {
  let file = {};
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) process.emitWarning(`${path} is readable by others; chmod 600 it`);
    file = JSON.parse(readFileSync(path, "utf8"));
  }
  const nixamp = file.nixamp ?? {};
  const school = file.school ?? {};
  const pairux = file.pairux ?? {};
  const server = trim(env.GOLIVE_NIXAMP_SERVER ?? nixamp.server);
  return {
    nixamp: {
      server,
      controlKey: String(env.GOLIVE_NIXAMP_CONTROL_KEY ?? nixamp.controlKey ?? ""),
      listenKey: String(env.GOLIVE_NIXAMP_LISTEN_KEY ?? nixamp.listenKey ?? ""),
      guide: trim(env.GOLIVE_NIXAMP_GUIDE ?? nixamp.guide ?? server),
      basis: String(nixamp.basis ?? "owned"),
    },
    school: {
      site: trim(env.GOLIVE_SCHOOL_SITE ?? school.site ?? "https://backtoschool.help"),
      token: String(env.GOLIVE_SCHOOL_TOKEN ?? env.NIXAMP_TOKEN ?? school.token ?? ""),
      topic: String(school.topic ?? ""),
    },
    pairux: {
      site: trim(env.GOLIVE_PAIRUX_SITE ?? pairux.site ?? "https://pairux.com"),
      agentKey: String(env.GOLIVE_PAIRUX_AGENT_KEY ?? env.PAIRUX_AGENT_KEY ?? pairux.agentKey ?? ""),
      channel: String(env.GOLIVE_PAIRUX_CHANNEL ?? pairux.channel ?? "").replace(/^@/, ""),
    },
  };
}

/** Why a target cannot run with this config, or "" when it can. */
export function missing(config, target) {
  if (target === "nixamp") {
    const n = config.nixamp;
    if (!n.server || !n.controlKey || !n.listenKey) return "nixamp needs server, controlKey and listenKey";
    return "";
  }
  if (target === "school") {
    if (missing(config, "nixamp")) return "backtoschool.help plays the nixamp channel, so it needs nixamp too";
    if (!config.school.token) return "backtoschool.help needs a nixamp token (nixamp token create)";
    return "";
  }
  if (target === "pairux") {
    if (!config.pairux.agentKey || !config.pairux.channel) return "pairux needs agentKey and channel";
    return "";
  }
  return `unknown target ${target}`;
}
