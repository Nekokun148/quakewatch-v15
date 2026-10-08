import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechController, quakeAnnouncement, eewAnnouncement } from '../js/speech.js';
import { SENSING_AREAS } from '../js/sensing-areas.js';

function harness(initialVoices = [], localStorage) {
  let voices = initialVoices;
  let nextTimer = 0;
  const timers = new Map();
  const listeners = new Map();
  const statuses = [];
  const played = [];
  const synth = {
    cancellations: 0,
    paused: false,
    getVoices: () => voices,
    addEventListener: (name, callback) => listeners.set(name, callback),
    speak: utterance => played.push(utterance),
    cancel() { this.cancellations++; },
    resume() { this.paused = false; }
  };
  const environment = {
    localStorage,
    speechSynthesis: synth,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  };
  const controller = createSpeechController({ environment, onStatus: status => statuses.push(status) });
  return {
    controller, synth, timers, played,
    status: () => statuses.at(-1),
    voicesChanged(next) { voices = next; listeners.get('voiceschanged')(); },
    finish(utterance = played.at(-1)) { utterance.onstart(); utterance.onend(); },
    timeout() { timers.values().next().value(); }
  };
}

test('starts off and only speaks after explicit activation', () => {
  const h = harness();
  assert.equal(h.status().phase, 'off');
  assert.equal(h.controller.say('test'), false);
  h.controller.enable();
  assert.equal(h.controller.say('test'), true);
  assert.equal(h.played[0].lang, 'ja-JP');
  h.finish();
  assert.equal(h.status().phase, 'ready');
  assert.equal(h.status().completed, 1);
  assert.equal(h.timers.size, 0);
});

test('late voice discovery prefers a local Japanese voice', () => {
  const h = harness();
  const local = { name: 'Japanese local', lang: 'ja-JP', localService: true };
  h.voicesChanged([
    { name: 'English', lang: 'en-US', localService: true, default: true },
    { name: 'Japanese remote', lang: 'ja-JP', default: true }, local
  ]);
  h.controller.enable();
  h.controller.say('test');
  assert.equal(h.played[0].voice, local);
});

test('voice selection lists only Japanese voices and stays silent while OFF', () => {
  const local = { voiceURI: 'local-ja', name: 'Local', lang: 'ja-JP', localService: true };
  const remote = { voiceURI: 'remote-ja', name: 'Remote', lang: 'ja_JP', localService: false };
  const h = harness([local, remote, { voiceURI: 'english', name: 'English', lang: 'en-US' }]);
  assert.deepEqual(h.status().voices.map(v => v.id), ['local-ja', 'remote-ja']);
  assert.equal(h.controller.setVoice('remote-ja'), true);
  assert.equal(h.status().voice, 'Remote');
  assert.equal(h.status().enabled, false);
  assert.equal(h.status().phase, 'off');
  assert.equal(h.played.length, 0);
  assert.equal(h.synth.cancellations, 0);
  assert.equal(h.controller.setVoice('english'), false);
  assert.equal(h.controller.setVoice('missing'), false);
  assert.equal(h.status().preferredVoice, 'remote-ja');
  h.controller.enable();
  h.controller.say('test');
  assert.equal(h.played[0].voice, remote);
});

test('a saved voice is restored after reload without automatically enabling speech', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const local = { voiceURI: 'local', name: 'Local', lang: 'ja-JP', localService: true };
  const selected = { voiceURI: 'selected', name: 'Selected', lang: 'ja-JP' };
  const first = harness([local, selected], storage);
  first.controller.setVoice('selected');
  assert.equal(values.get('qwSpeechVoice'), 'selected');
  const next = harness([selected, local], storage);
  assert.equal(next.status().preferredVoice, 'selected');
  assert.equal(next.status().voice, 'Selected');
  assert.equal(next.status().enabled, false);
  assert.equal(next.played.length, 0);
  next.controller.enable();
  next.controller.say('test');
  assert.equal(next.played[0].voice, selected);
  next.finish();
  assert.equal(next.controller.setVoice(''), true);
  assert.equal(next.status().voice, 'Local');
  assert.equal(values.get('qwSpeechVoice'), '');
});

test('late or removed preferred voices fall back and return without losing the preference', () => {
  const local = { voiceURI: 'local', name: 'Local', lang: 'ja-JP', localService: true };
  const saved = { voiceURI: 'saved', name: 'Saved', lang: 'ja-JP' };
  const h = harness([], { getItem: () => 'saved' });
  assert.equal(h.status().preferredVoice, 'saved');
  assert.equal(h.status().voice, '');
  h.voicesChanged([local]);
  assert.equal(h.status().voice, 'Local');
  h.voicesChanged([saved, local]);
  assert.equal(h.status().voice, 'Saved');
  h.controller.enable();
  h.controller.say('first');
  h.voicesChanged([local]);
  assert.equal(h.played[0].voice, saved);
  assert.equal(h.status().preferredVoice, 'saved');
  h.controller.say('next');
  h.finish();
  assert.equal(h.played[1].voice, local);
  h.voicesChanged([local, saved]);
  h.controller.say('returned');
  h.finish();
  assert.equal(h.played[2].voice, saved);
  assert.equal(h.synth.cancellations, 0);
});

test('a voice change preserves active and queued reports and EEW priority', () => {
  const first = { voiceURI: 'first', name: 'First', lang: 'ja-JP', localService: true };
  const second = { voiceURI: 'second', name: 'Second', lang: 'ja-JP' };
  const h = harness([first, second]);
  h.controller.enable();
  h.controller.say('first');
  h.controller.say('queued');
  const active = h.played[0];
  h.controller.setVoice('second');
  assert.equal(active.voice, first);
  assert.equal(h.played.length, 1);
  assert.equal(h.synth.cancellations, 0);
  h.finish();
  assert.equal(h.played[1].text, 'queued');
  assert.equal(h.played[1].voice, second);
  h.controller.say('ordinary');
  h.controller.say('emergency', { interrupt: true });
  assert.equal(h.synth.cancellations, 1);
  assert.equal(h.played[2].text, 'emergency');
  assert.equal(h.played[2].voice, second);
  h.played[1].onerror({ error: 'cancelled' });
  h.finish();
  assert.equal(h.status().enabled, true);
  assert.equal(h.played.length, 3);
});

test('same-named voices remain selectable by their distinct URI', () => {
  const first = { voiceURI: 'first', name: 'Japanese', lang: 'ja-JP', localService: true };
  const second = { voiceURI: 'second', name: 'Japanese', lang: 'ja-JP', localService: false };
  const h = harness([first, second]);
  h.controller.setVoice('second');
  h.voicesChanged([{ ...second }, { ...first }]);
  h.controller.enable();
  h.controller.say('test');
  assert.equal(h.played[0].voice.voiceURI, 'second');
});

test('unavailable storage does not prevent choosing or playing a voice', () => {
  const local = { voiceURI: 'local', name: 'Local', lang: 'ja-JP' };
  const h = harness([local], {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage full'); }
  });
  assert.equal(h.controller.setVoice('local'), true);
  assert.equal(h.status().preferredVoice, 'local');
  h.controller.enable();
  h.controller.say('test');
  assert.equal(h.played[0].voice, local);
});

test('ordinary reports queue without interrupting the active speech', () => {
  const h = harness();
  h.controller.enable();
  h.controller.say('first');
  h.controller.say('second');
  assert.equal(h.played.length, 1);
  assert.equal(h.synth.cancellations, 0);
  h.finish();
  assert.equal(h.played[1].text, 'second');
  h.finish();
  assert.equal(h.status().completed, 2);
});

test('emergency interruption ignores late callbacks from cancelled speech', () => {
  const h = harness();
  h.controller.enable();
  h.controller.say('old');
  const old = h.played[0];
  h.controller.say('emergency', { interrupt: true });
  old.onerror({ error: 'interrupted' });
  old.onend();
  assert.equal(h.status().enabled, true);
  assert.equal(h.status().error, '');
  assert.equal(h.played.length, 2);
  h.finish();
  assert.equal(h.status().completed, 1);
});

test('turning off clears the queue and ignores cancelled callbacks', () => {
  const h = harness();
  h.controller.enable();
  h.controller.say('first');
  h.controller.say('queued');
  const old = h.played[0];
  h.controller.disable();
  old.onerror({ error: 'cancelled' });
  old.onend();
  assert.equal(h.status().phase, 'off');
  assert.equal(h.played.length, 1);
  assert.equal(h.timers.size, 0);
});

test('a blocked engine reports an error and explicit retry recovers', () => {
  const h = harness();
  h.controller.enable();
  h.controller.say('blocked');
  h.played[0].onerror({ error: 'not-allowed' });
  assert.equal(h.status().phase, 'error');
  assert.equal(h.status().enabled, false);
  assert.match(h.status().error, /音声テスト/);
  h.controller.enable();
  h.controller.say('retry');
  h.finish();
  assert.equal(h.status().phase, 'ready');
  assert.equal(h.status().error, '');
});

test('the start watchdog catches silent engine failures', () => {
  const h = harness();
  h.controller.enable();
  h.controller.say('test');
  h.timeout();
  assert.equal(h.status().enabled, false);
  assert.equal(h.status().phase, 'error');
  assert.equal(h.status().started, 0);
});

test('unsupported browsers do not attempt speech', () => {
  let status;
  const speech = createSpeechController({ environment: {}, onStatus: value => { status = value; } });
  assert.equal(status.phase, 'unsupported');
  assert.equal(speech.enable(), false);
  assert.equal(speech.say('test'), false);
  assert.equal(speech.setVoice('anything'), false);
  assert.deepEqual(status.voices, []);
});

test('long announcements retain their text in bounded chunks', () => {
  const h = harness();
  const text = '揺'.repeat(310) + '。';
  h.controller.enable();
  h.controller.say(text);
  for (let index = 0; index < 3; index++) h.finish();
  assert.equal(h.played.map(u => u.text).join(''), text);
  assert.ok(h.played.every(u => Array.from(u.text).length <= 120));
  assert.equal(h.status().phase, 'ready');
});

for (const scale of [10, 20]) {
  test(`weak intensity ${scale / 10} includes observed regions`, () => {
    const text = quakeAnnouncement({
      earthquake: { maxScale: scale, hypocenter: { name: '東京湾', magnitude: 2.1, depth: 10 } },
      points: [{ pref: '東京都', addr: '千代田区', scale }]
    }, value => String(value / 10));
    assert.match(text, new RegExp(`最大震度は${scale / 10}`));
    assert.match(text, /東京都千代田区/);
    assert.match(text, /マグニチュード2.1/);
    assert.match(text, /深さは10キロ/);
  });
}

test('unknown magnitude and depth are not read as negative numbers', () => {
  const text = quakeAnnouncement({ earthquake: { hypocenter: { magnitude: -1, depth: -1 } } }, () => '不明');
  assert.doesNotMatch(text, /マグニチュード|キロメートル/);
});

test('an EEW without a region list still produces an announcement', () => {
  assert.match(eewAnnouncement({ earthquake: { hypocenter: { name: '東京湾' } }, areas: [] }), /緊急地震速報。震源は東京湾。/);
});

test('sensing region codes use the published regional mapping', () => {
  assert.equal(Object.keys(SENSING_AREAS).length, 138);
  assert.equal(SENSING_AREAS[200].name, '茨城北部');
  assert.equal(SENSING_AREAS[Number('010')].name, '北海道 石狩');
  assert.equal(SENSING_AREAS[705].name, '沖縄八重山');
  assert.equal(SENSING_AREAS[901], undefined);
});
