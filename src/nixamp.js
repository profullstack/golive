/**
 * nixamp: a server carries the link as a live channel, the live.streaming
 * guide lists it as a room, and backtoschool.help runs it as a live class.
 *
 * - POST {server}/api/links/play {url, live:true}   the server pulls the media and goes live
 * - PATCH {server}/api/channels/<id> {name}          under the episode's title
 * - POST {guide}/api/v1/guide/rooms {play, basis}    a room on live.streaming
 * - POST {school}/api/v1/events {broadcastUrl}       a live public class, then /start
 *
 * Only the listen (view) key is ever published; the control key rides in a
 * header to our own server and the guide.
 */
import { request } from "./http.js";

const KEY_HEADER = "x-nixamp-key";

export function channelStream(config, channel) {
  return `${config.nixamp.server}/api/channels/${encodeURIComponent(channel)}?k=${config.nixamp.listenKey}`;
}

/** The nixamp.com player on this channel: what a class embeds. */
export function channelPlayer(config, channel) {
  const player = new URL("https://nixamp.com/");
  player.searchParams.set("url", `${config.nixamp.server}/view/${config.nixamp.listenKey}`);
  player.searchParams.set("play", `channel:${channel}`);
  return player.href;
}

export async function goLive(config, { url, title }, fetcher = fetch) {
  const { server, controlKey } = config.nixamp;
  const headers = { [KEY_HEADER]: controlKey };
  // yt-dlp + ffprobe on the server can take a while on a cold link.
  const shown = await request(`${server}/api/links/play`, { method: "POST", headers, body: { url, live: true }, timeoutMs: 90_000, fetcher });
  const channel = String(shown.channel ?? "");
  if (!channel) throw new Error(`nixamp did not say which channel it put ${url} on`);
  if (title) {
    await request(`${server}/api/channels/${encodeURIComponent(channel)}`, { method: "PATCH", headers, body: { name: title }, fetcher });
  }
  return { channel, stream: channelStream(config, channel), player: channelPlayer(config, channel) };
}

/**
 * Is the channel still on the air? false once it ended (its outro is playing)
 * or is gone; null when the server cannot be asked. A channel's `live` says
 * whether its SOURCE is a live feed (false for an mp3), not whether it is on.
 */
export async function channelLive(config, channel, fetcher = fetch) {
  try {
    const body = await request(`${config.nixamp.server}/api/channels?k=${config.nixamp.listenKey}`, { timeoutMs: 10_000, fetcher });
    const row = (body.channels ?? []).find((one) => one.id === channel);
    if (!row) return false;
    return !row.ended;
  } catch {
    return null;
  }
}

export async function takeOff(config, channel, fetcher = fetch) {
  await request(`${config.nixamp.server}/api/channels/${encodeURIComponent(channel)}`, {
    method: "DELETE", headers: { [KEY_HEADER]: config.nixamp.controlKey }, fetcher,
  }).catch((error) => { if (error.status !== 404) throw error; });
}

export async function publishRoom(config, { channel, title, note }, fetcher = fetch) {
  const { guide, controlKey, basis } = config.nixamp;
  const body = await request(`${guide}/api/v1/guide/rooms`, {
    method: "POST",
    headers: { [KEY_HEADER]: controlKey },
    body: { play: channelStream(config, channel), basis, agree: true, title: (title ?? "").slice(0, 120), note: (note ?? "").slice(0, 300) },
    fetcher,
  });
  return { id: String(body.room?.id ?? ""), page: String(body.page ?? "") };
}

export async function removeRoom(config, id, fetcher = fetch) {
  if (!id) return;
  await request(`${config.nixamp.guide}/api/v1/guide/rooms/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { [KEY_HEADER]: config.nixamp.controlKey }, fetcher,
  }).catch((error) => { if (error.status !== 404) throw error; });
}

// --- backtoschool.help ---------------------------------------------------------

const schoolHeaders = (config) => ({ authorization: `Bearer ${config.school.token}` });

export async function startClass(config, { channel, title, description }, fetcher = fetch) {
  const site = config.school.site;
  const made = await request(`${site}/api/v1/events`, {
    method: "POST",
    headers: schoolHeaders(config),
    body: {
      kind: "class",
      visibility: "public",
      title: title.slice(0, 160),
      description: (description ?? "").slice(0, 4000),
      ...(config.school.topic ? { topic: config.school.topic } : {}),
      broadcastUrl: channelPlayer(config, channel),
    },
    fetcher,
  });
  const event = made.event ?? made;
  const started = await request(`${site}/api/v1/events/${encodeURIComponent(event.id)}/start`, {
    method: "POST", headers: schoolHeaders(config), body: { version: event.version }, fetcher,
  });
  const live = started.event ?? started;
  const slug = live.slug ?? event.slug;
  return { id: String(live.id ?? event.id), slug: String(slug), page: `${site}/live/${slug}` };
}

export async function endClass(config, id, fetcher = fetch) {
  if (!id) return;
  const site = config.school.site;
  const current = await request(`${site}/api/v1/events/${encodeURIComponent(id)}`, { headers: schoolHeaders(config), fetcher });
  const event = current.event ?? current;
  if (event.status !== "live") return;
  await request(`${site}/api/v1/events/${encodeURIComponent(id)}/end`, {
    method: "POST", headers: schoolHeaders(config), body: { version: event.version }, fetcher,
  });
}
