// A stand-in for the Claude Messages API. It answers each BuildLens call
// (identified by the "CALL: <name>" line in the system prompt) with a
// streamed, schema-shaped response, and records every request for assertions.
export function createMock() {
  const state = {
    requests: [],
    next: [],            // queued one-shot behaviours: 'refusal' | 'offline' | 'overloaded' | 'max_tokens'
    checkVerdicts: [],   // queued check verdicts; default 'pass'
  };

  const callOf = body => (body.system?.[0]?.text.match(/CALL: (\w+)/) || [])[1];
  const textOf = body => body.messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const photoDims = body => {
    const m = [...textOf(body).matchAll(/PHOTO \((\d+)×(\d+) px\)/g)].at(-1);
    return m ? [+m[1], +m[2]] : [1000, 1000];
  };

  const furnitureGuide = {
    product: { name: 'KALLBO shelf', brand: 'Test', model: 'K1', category: 'furniture' },
    modes: [],
    parts: [{ id: 'A', name: 'Side panel', qty: 2, description: 'Tall panel', visualCues: 'holes on one long edge' }, { id: 'B', name: 'Shelf', qty: 1, description: 'Short panel', visualCues: 'no holes' }],
    hardware: [{ id: '101', name: 'Cam bolt', qty: 4, sizeHint: 'about 3 cm, silver' }],
    tools: ['Allen key (included)'],
    vehicleFacts: [],
    steps: [
      { n: 1, title: 'Insert cam bolts', instruction: 'Screw 4 cam bolts 101 into panel A.', modes: [], parts: ['A'], hardware: [{ id: '101', qty: 4 }], tools: ['Allen key (included)'], manualPage: 2, manualBox: [300, 500, 500, 350], cautions: [], checkCriteria: ['Four bolts in panel A'], humanChecks: [] },
      { n: 2, title: 'Attach shelf', instruction: 'Push shelf B onto the bolts in panel A.', modes: [], parts: ['A', 'B'], hardware: [], tools: [], manualPage: 2, manualBox: [300, 500, 500, 350], cautions: ['Holes face inward'], checkCriteria: ['B is level', 'Holes face inward'], humanChecks: [] },
      { n: 3, title: 'Attach second side', instruction: 'Fit the second panel A and turn the cam locks.', modes: [], parts: ['A'], hardware: [], tools: ['Allen key (included)'], manualPage: 3, manualBox: [300, 600, 500, 350], cautions: [], checkCriteria: ['Second A attached'], humanChecks: [{ check: 'Cam locks turned', howTo: 'Turn each cam lock clockwise until it stops.' }] },
    ],
  };
  const carGuide = withVehicle => ({
    product: { name: 'SafeRide 360', brand: 'SafeRide', model: '360', category: 'car_seat' },
    modes: [{ id: 'rf_latch', label: 'Rear-facing with lower anchors', description: '5–40 lb' }, { id: 'rf_belt', label: 'Rear-facing with seat belt', description: '5–40 lb' }, { id: 'ff', label: 'Forward-facing with tether', description: '22–65 lb' }],
    parts: [{ id: 'S', name: 'Seat shell', qty: 1, description: '', visualCues: '' }],
    hardware: [], tools: [],
    vehicleFacts: withVehicle ? [{ fact: 'Tether anchors are on the rear shelf behind each headrest.', vehiclePage: 1 }] : [],
    steps: [
      { n: 1, title: 'Set recline', instruction: 'Set the recline to position 1 or 2.', modes: ['rf_latch', 'rf_belt'], parts: ['S'], hardware: [], tools: [], manualPage: 2, manualBox: [300, 700, 500, 350], cautions: [], checkCriteria: ['Recline in position 1 or 2'], humanChecks: [{ check: 'Recline indicator in the blue zone', howTo: 'Look at the bubble on the side of the seat.' }] },
      { n: 2, title: 'Attach lower anchors', instruction: 'Clip both lower anchor connectors to the anchors in the seat crease.', modes: ['rf_latch'], parts: ['S'], hardware: [], tools: [], manualPage: 2, manualBox: [300, 700, 500, 350], cautions: [], checkCriteria: ['Both connectors attached'],
        humanChecks: [{ check: 'Lower anchors are the car’s anchors, not other hardware', howTo: 'Find the anchor symbol tag on the seat crease; no vehicle manual was added.' }, { check: 'Seat moves less than 1 inch', howTo: 'Hold the seat at the belt path and tug side to side.' }] },
      { n: 3, title: 'Attach tether', instruction: 'Hook the top tether to the tether anchor.', modes: ['ff'], parts: ['S'], hardware: [], tools: [], manualPage: 2, manualBox: [0, 0, 0, 0], cautions: [], checkCriteria: [], humanChecks: [{ check: 'Tether is on the tether anchor, not a cargo hook', howTo: 'Look for the tether anchor symbol.' }] },
    ],
  });

  function respond(body) {
    const call = callOf(body); const [w, h] = photoDims(body); const text = textOf(body);
    switch (call) {
      case 'testConnection': return { ok: true };
      case 'parseManual': {
        if (/Product category chosen by the user: car_seat/.test(text)) return carGuide(/Vehicle manual pages provided: yes/.test(text));
        return furnitureGuide;
      }
      case 'scanInventory': {
        if (/vehicle back seat/.test(text)) return { items: [], missing: [], uncertain: [], vehicleMarks: [{ kind: 'lower_anchor', label: 'Lower anchor tag', box: [w * 0.36, h * 0.66, w * 0.07, h * 0.06], confidence: 0.7 }], retakeHint: null };
        return { items: [{ ref: 'A', box: [w * 0.05, h * 0.05, w * 0.3, h * 0.4], confidence: 0.92 }, { ref: 'B', box: [w * 0.55, h * 0.1, w * 0.3, h * 0.25], confidence: 0.88 }, { ref: '101', box: [w * 0.6, h * 0.6, w * 0.1, h * 0.08], confidence: 0.45 }],
          missing: [], uncertain: [{ box: [w * 0.05, h * 0.55, w * 0.3, h * 0.35], candidates: ['A', 'B'] }], vehicleMarks: [], retakeHint: null };
      }
      case 'guideStep': {
        const corr = text.match(/at about \((\d+), (\d+)\)/);
        if (corr) { const [x, y] = [+corr[1], +corr[2]]; return { instruction: 'Use this panel instead.', highlights: [{ ref: 'A', role: 'use', label: 'Panel A', box: [x - 100, y - 100, 200, 200], confidence: 0.95 }], arrows: [], notVisible: [], retakeHint: null }; }
        const place = /PLACE photo/.test(text);
        return place
          ? { instruction: 'Slide shelf B into the holes on panel A.', highlights: [{ ref: 'B', role: 'use', label: 'Shelf B', box: [w * 0.5, h * 0.35, w * 0.37, h * 0.2], confidence: 0.9 }, { ref: 'A', role: 'target', label: 'Here', box: [w * 0.13, h * 0.15, w * 0.3, h * 0.7], confidence: 0.85 }], arrows: [{ from: [w * 0.5, h * 0.45], to: [w * 0.43, h * 0.45], label: 'slide in' }], notVisible: [], retakeHint: null }
          : { instruction: 'Grab panel A by your left foot and 4 cam bolts 101.', highlights: [{ ref: 'A', role: 'use', label: 'Panel A', box: [w * 0.05, h * 0.05, w * 0.3, h * 0.4], confidence: 0.93 }, { ref: '101', role: 'use', label: '4 × 101', box: [w * 0.6, h * 0.6, w * 0.1, h * 0.08], confidence: 0.4 }, { ref: 'key', role: 'tool', label: 'Allen key', box: [w * 0.75, h * 0.8, w * 0.1, h * 0.1], confidence: 0.8 }], arrows: [], notVisible: ['Allen key'], retakeHint: null };
      }
      case 'checkStep': {
        const v = state.checkVerdicts.shift() || 'pass';
        if (v === 'fix') return { verdict: 'fix', summary: 'Shelf B is upside down.', issues: [{ box: [w * 0.43, h * 0.35, w * 0.37, h * 0.2], problem: 'Shelf B is upside down', fix: 'Flip it so the holes face up' }], retakeHint: null };
        if (v === 'unsure') return { verdict: 'unsure', summary: '', issues: [], retakeHint: 'Step back so the whole shelf is in frame.' };
        return { verdict: 'pass', summary: 'Matches the manual.', issues: [], retakeHint: null };
      }
      default: throw new Error('mock: unknown call ' + call);
    }
  }

  function sse(body, json, stop = 'end_turn') {
    const model = body.model; const s = JSON.stringify(json); const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    let out = ev('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1200, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 1 } } });
    out += ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }) + ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '' } }) + ev('content_block_stop', { index: 0 });
    out += ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < s.length; i += 97) out += ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: s.slice(i, i + 97) } });
    out += ev('content_block_stop', { index: 1 }) + ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 420 } }) + ev('message_stop', {});
    return out;
  }

  async function handler(route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors() });
    const body = JSON.parse(req.postData());
    state.requests.push({ url: req.url(), headers: req.headers(), body, call: callOf(body) });
    const mode = state.next.shift();
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'overloaded') return route.fulfill({ status: 529, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) });
    if (mode === 'unauthorized') return route.fulfill({ status: 401, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    if (mode === 'refusal') return route.fulfill({ status: 200, headers: { ...cors(), 'content-type': 'text/event-stream' }, body: sse(body, {}, 'refusal') });
    let json; try { json = respond(body); } catch (e) { return route.fulfill({ status: 400, headers: cors(), body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: e.message } }) }); }
    return route.fulfill({ status: 200, headers: { ...cors(), 'content-type': 'text/event-stream' }, body: sse(body, json) });
  }
  const cors = () => ({ 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' });
  return { state, handler };
}
