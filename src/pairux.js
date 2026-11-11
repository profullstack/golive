/**
 * PairUX: an account agent opens a live room on a channel
 * (POST /api/v1/agent/broadcasts) and publishes the audio into it over LiveKit
 * from this machine: ffmpeg decodes the link to 48 kHz PCM and the frames go
 * out as a microphone track. The room's host IS the publisher, so when it
 * leaves PairUX ends the live by itself; DELETE says so straight away.
 */
import { spawn } from "node:child_process";
import { request } from "./http.js";

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
/** 20 ms frames: what Opus packs, and small enough to stop promptly. */
const FRAME_SAMPLES = SAMPLE_RATE / 50;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

const agentHeaders = (config) => ({ authorization: `Bearer ${config.pairux.agentKey}` });

export async function openBroadcast(config, { title, description }, fetcher = fetch) {
  const body = await request(`${config.pairux.site}/api/v1/agent/broadcasts`, {
    method: "POST",
    headers: agentHeaders(config),
    body: { channel: config.pairux.channel, title: title.slice(0, 200), ...(description ? { description: description.slice(0, 5000) } : {}) },
    fetcher,
  });
  return body.data;
}

export async function heartbeat(config, sessionId, fetcher = fetch) {
  const body = await request(`${config.pairux.site}/api/v1/agent/broadcasts/${sessionId}`, {
    method: "POST", headers: agentHeaders(config), timeoutMs: 15_000, fetcher,
  });
  return body.data?.live === true;
}

export async function closeBroadcast(config, sessionId, fetcher = fetch) {
  if (!sessionId) return;
  await request(`${config.pairux.site}/api/v1/agent/broadcasts/${sessionId}`, {
    method: "DELETE", headers: agentHeaders(config), fetcher,
  }).catch((error) => { if (error.status !== 404) throw error; });
}

/** ffmpeg arguments that turn any link ffmpeg can read into raw mono 48 kHz PCM on stdout. */
export function decoderArgs(url, { live = false } = {}) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    // A file is read at its own pace (else it would be sent in seconds); a live feed already is.
    ...(live ? [] : ["-re"]),
    ...(/^https?:/i.test(url) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"] : []),
    "-i", url,
    "-vn", "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1",
  ];
}

/**
 * Publishes `url` into the room until it ends (or `signal` aborts). Resolves
 * with the seconds sent. `ffmpeg` is the binary to run.
 */
export async function publish({ url: liveKitUrl, token }, source, { live = false, ffmpeg = "ffmpeg", signal, log = () => {} } = {}) {
  const rtc = await import("@livekit/rtc-node");
  const room = new rtc.Room();
  await room.connect(liveKitUrl, token, { autoSubscribe: false, dynacast: false });
  const audio = new rtc.AudioSource(SAMPLE_RATE, CHANNELS, 1000);
  const track = rtc.LocalAudioTrack.createAudioTrack("podcast", audio);
  const options = new rtc.TrackPublishOptions();
  options.source = rtc.TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  log("pairux: publishing into the room");

  let frames = 0;
  let attempts = 0;
  try {
    for (;;) {
      const started = Date.now();
      const { code, stderr } = await decode(ffmpeg, source, live, signal, async (samples) => {
        await audio.captureFrame(new rtc.AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
        frames += 1;
      });
      if (signal?.aborted || !live) {
        if (code !== 0 && !signal?.aborted) log(`pairux: ffmpeg exited ${code}: ${stderr}`);
        break;
      }
      // A live feed that stops may have dropped rather than ended: dial it again,
      // a few times, unless it ran a good while first (then it simply ended).
      attempts = Date.now() - started > 120_000 ? 1 : attempts + 1;
      if (attempts > 3 || !(await reachable(source))) break;
      log(`pairux: the feed stopped (${stderr || `exit ${code}`}); dialling it again`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    await audio.waitForPlayout().catch(() => undefined);
  } finally {
    await audio.close().catch(() => undefined);
    await room.disconnect().catch(() => undefined);
    await rtc.dispose().catch(() => undefined);
  }
  return frames / 50;
}

/** Runs one ffmpeg, handing each 20 ms frame to `onFrame`; resolves with its exit code. */
async function decode(ffmpeg, source, live, signal, onFrame) {
  const child = spawn(ffmpeg, decoderArgs(source, { live }), { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  const stop = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", stop, { once: true });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= FRAME_BYTES) {
        // Copied: the Int16Array must own aligned memory, and the buffer is reused.
        const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
        Buffer.from(samples.buffer).set(pending.subarray(0, FRAME_BYTES));
        pending = pending.subarray(FRAME_BYTES);
        await onFrame(samples);
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    child.kill("SIGTERM");
  }
  return { code: await closed, stderr: stderr.trim().split("\n").pop() ?? "" };
}

async function reachable(url) {
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
