# golive

Put a recording or a live audio feed on the air everywhere at once, with one command after you publish an episode.

```sh
golive start https://example.com/episode-12.mp3 --title "Episode 12: Owning your keys" \
  --description "Show notes, one paragraph."
```

`start` returns once every target is live, prints where it plays, and leaves a background run that holds it on the air and takes it down everywhere when the audio ends.

| Target | What happens |
| --- | --- |
| `nixamp` | Your nixamp server pulls the link as a live channel (`POST /api/links/play`), named after the episode, and the live.streaming guide lists it as a room (`POST /api/v1/guide/rooms`, rights basis `owned`). |
| `school` | backtoschool.help runs a live public class that plays that channel (`POST /api/v1/events`, then `/start`). |
| `pairux` | A PairUX account agent opens a live on a channel (`POST /api/v1/agent/broadcasts`) and publishes the audio into its LiveKit room from this machine (ffmpeg decodes it to 48 kHz PCM, `@livekit/rtc-node` sends it). |

Each target fails on its own: a refused class never stops the stream, and the run's state file says what went wrong next to what worked.

## Commands

```
golive start URL --title T [--description D] [--live] [--only nixamp,school,pairux] [--json] [--wait]
golive run URL --title T ...     the same, in the foreground
golive list                      runs, newest first
golive status ID [--json]        one run
golive stop ID                   end it now, everywhere
golive check                     which targets the config can reach
```

`URL` is anything ffmpeg reads: an mp3 or m4a link, an HLS playlist, an Icecast stream. Pass `--live` for a feed that is live itself, such as a call being recorded: it is not paced, and a dropped feed is dialled again (three times) before the run ends.

## Config

`~/.config/golive/config.json` (or `$GOLIVE_CONFIG`), mode 600. Keys never go on the command line.

```json
{
  "nixamp": {
    "server": "https://server2.example.nixamp.com:4321",
    "controlKey": "<keys.json key>",
    "listenKey": "<keys.json listenKey>",
    "guide": "https://server2.example.nixamp.com:4321",
    "basis": "owned"
  },
  "school": { "site": "https://backtoschool.help", "token": "<nixamp token create>", "topic": "Podcasts" },
  "pairux": { "site": "https://pairux.com", "agentKey": "pux_ag_...", "channel": "moshcoding" }
}
```

Only the listen key is ever published (in the room and class links); the control key goes in a header to your own server. Any value can be overridden for one run from the environment: `GOLIVE_NIXAMP_SERVER`, `GOLIVE_NIXAMP_CONTROL_KEY`, `GOLIVE_NIXAMP_LISTEN_KEY`, `GOLIVE_NIXAMP_GUIDE`, `GOLIVE_SCHOOL_TOKEN` (or `NIXAMP_TOKEN`), `GOLIVE_PAIRUX_AGENT_KEY` (or `PAIRUX_AGENT_KEY`), `GOLIVE_PAIRUX_CHANNEL`. Runs keep their state and log in `~/.local/state/golive/`.

## Needs

Node 20 or later and `ffmpeg` on the PATH (only for the `pairux` target; nixamp servers pull the link themselves).

## As a library

```js
import { loadConfig, run } from "@profullstack/golive";
const state = await run(loadConfig(), { url, title, description });
```

MIT, Profullstack, Inc.
