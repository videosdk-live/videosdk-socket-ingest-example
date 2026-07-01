# VideoSDK Socket Ingestion Example

A minimal, dependency-free browser example (HTML + CSS + vanilla JS) that
demonstrates the **custom WebSocket** socket-ingestion path: stream microphone
audio into a VideoSDK room over a WebSocket, play the room's audio back, and
exchange topic-based pub/sub messages.

Guide: [Custom WebSocket](https://docs.videosdk.live/telephony/connectors/custom-websocket)

## Features

- Create an ingest session (`POST /v2/ingest/sessions`)
- Connect the WebSocket and send the `start` frame
- Capture the microphone, resample to **8 kHz mono PCM16**, and send `media` frames
- Play room audio received as `media` frames
- Pub/sub messaging: `subscribe`, `unsubscribe`, `message` (publish), and receiving messages
- Send `stop` to end the session

## Prerequisites

- A [VideoSDK account](https://app.videosdk.live/) and an API token. See
  [Authentication and Tokens](https://docs.videosdk.live/docs/guide/video-and-audio-calling-api-sdk/authentication-and-tokens).
- A `roomId`. Create one with the
  [Create Room API](https://docs.videosdk.live/api-reference/realtime-communication/create-room).
- A modern browser with microphone access (Chrome, Edge, Firefox, Safari).

## Setup

Open `config.js` and paste your VideoSDK token:

```js
window.CONFIG = {
  token: "PASTE_YOUR_VIDEOSDK_TOKEN_HERE",
  roomId: "", // optional default
};
```

> The token in `config.js` is for local testing only. Never ship your token to
> the browser in production (see [Production note](#production-note)).

## Run it

The example is fully static. Serve the folder over HTTP (microphone access
requires a secure context, and `localhost` counts):

```bash
live-server .

# Python
python3 -m http.server 8080

# or Node
npx serve .
```

Open `http://localhost:8080` and:

1. **Ingest session:** enter a Room ID and click **Create session**. The token
   comes from `config.js`, and the `wsUrl` fills in automatically.
2. **Connect & stream:** click **Connect**, then **Start Microphone**.
3. **Messaging:** subscribe to a topic and publish a message.

> Join the same room from another VideoSDK client (or attach an agent) to hear
> the streamed audio and exchange messages.

## Production note

This demo creates the session from the browser using the token in `config.js`,
which is fine for local testing but **not for production**. In production,
create the session on your backend and hand the client only the single-use
`wsUrl`:

```bash
curl -X POST https://api.videosdk.live/v2/ingest/sessions \
  -H "Authorization: Bearer $VIDEOSDK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "roomId": "abcd-efgh-ijkl" }'
```

Then paste the returned `wsUrl` into the **WebSocket URL** field.

## Files

| File         | Purpose                                                         |
| ------------ | --------------------------------------------------------------- |
| `index.html` | UI markup                                                       |
| `config.js`  | Your token and optional defaults                                |
| `app.js`     | Session, WebSocket, audio capture/playback, and messaging logic |
| `style.css`  | Minimal styling                                                 |

## License

MIT
