# BuildLens

A photo-by-photo coach for car seats and flat-pack furniture. Photograph the manual, then photograph your parts and your build: BuildLens shows the same photo with the next parts boxed in green, where they go outlined, and one plain instruction. A check photo returns a pass or a red box on the mistake. Things a photo can't judge (tightness, harness, recline, cam locks) become a hands-on checklist.

Product spec: the BuildLens PRD (Claude Docs).

## Run it

It is one static file. Serve the folder over HTTPS (GitHub Pages works) or locally:

```sh
python3 -m http.server 8123   # then open http://localhost:8123
```

Open **Settings** (⚙):

- **My API key (testing)** — paste an Anthropic API key. It is stored on that device only, in plain text. Use this for your own testing.
- **Key proxy (family and friends)** — enter the proxy URL and a passcode. The key stays in the proxy.

Then **New build** → pick car seat / furniture / something else → add the manual (photos or PDF) → **Read manual** → inventory photo → step loop: grab photo → place photo → check photo → hands-on checks.

## Car seats

- Four jobs: first install, move to another car, check an existing install, convert mode.
- Vehicle year, make and model are required. The vehicle manual's child-seat pages are optional; without them BuildLens never states car-specific facts (tether anchor location, lower anchors, belt locking) and turns them into hands-on checks.
- Hands-on checks must all be ticked before a car seat step can move on. The finish screen points to a certified technician.

## Key proxy (Cloudflare Worker)

`proxy/worker.js` holds your API key and checks a per-person passcode.

```sh
cd proxy
npx wrangler secret put ANTHROPIC_API_KEY     # your key
npx wrangler secret put PASSCODES             # e.g. mom-7341,dad-2290
# set ALLOWED_ORIGIN in wrangler.toml to your app's origin
npx wrangler deploy
```

Put the worker URL in Settings → Key proxy. Spend caps are not built yet.

## Models and cost

Defaults (change in Settings): `claude-opus-5-5` reads the manual; `claude-sonnet-5-5` handles inventory, grab/place and check photos. Swap step or check calls to `claude-haiku-5-5` to compare. Every overlay has a **Was this right?** 👍/👎; the **Log** screen shows hit rate per model, tokens, latency and cost, and exports JSON.

API details: structured outputs (`output_config.format`, no forced `tool_choice`), streaming, API version `2026-10-21`, prompt caching on the guide, `effort: low` on photo calls, refusal fallbacks on Opus/Sonnet, photos sent at up to 2576 px on the long edge.

## Tests

```sh
cd tests
npm install                 # pdf.js for the tests
python3 make_fixtures.py    # synthetic manuals and photos
node proxy.test.mjs         # proxy unit tests
node e2e.mjs                # Chromium end-to-end tests against a mocked Claude API
```

The end-to-end tests mock the Claude API, so they check the app's flow, requests and rendering — not model accuracy. Accuracy (M2) needs real photos and a real key.
