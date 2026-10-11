import test from 'node:test';
import assert from 'node:assert/strict';
import { eewInfo, createEEWTracker } from '../js/eew.js';
import { createSpeechController, eewAnnouncement } from '../js/speech.js';
import { createAlarmController, createAlarmAnnouncer } from '../js/alarm.js';

const time = '2026/10/07 21:20:00';
const now = Date.parse('2026-10-07T21:20:01+09:00');
const report = extra => ({ code: 556, issue: { eventId: 'test-event', serial: '1', time }, earthquake: { hypocenter: { name: 'テスト震源' } }, areas: [{ pref: '東京都', name: '東京テスト地域', scaleFrom: 30, scaleTo: 40, kindCode: '10' }], ...extra });

test('warning, forecast, final and cancellation stages reflect explicit data, never report counts alone', () => {
  assert.equal(eewInfo(report()).stage, '警報・第1報');
  assert.equal(eewInfo(report({ isWarning: false })).stage, '予報・第1報');
  assert.equal(eewInfo(report({ isFinal: true })).stage, '警報・最終報');
  assert.equal(eewInfo(report({ cancelled: true, earthquake: undefined })).stage, '取消');
  assert.equal(eewInfo(report({ issue: { ...report().issue, serial: '99' } })).final, false);
});

test('intensity colors, upper-unbounded ranges and PLUM codes retain their meanings', () => {
  const info = eewInfo(report({ areas: [
    { name: 'PLUM', kindCode: '19', scaleFrom: 45, scaleTo: 99 },
    { name: 'normal', kindCode: '10', scaleFrom: 10, scaleTo: 20 }
  ] }));
  assert.equal(info.maxScale, 45); assert.equal(info.plum, true);
  assert.equal(info.maxAbove, true);
  assert.equal(eewInfo(report()).maxAbove, false);
  assert.equal(info.areas[0].above, true); assert.equal(info.areas[0].plum, true);
  assert.equal(eewInfo(report()).color, '#fb923c');
  assert.equal(eewInfo(report({ areas: [] })).maxScale, -1);
});

test('unknown and invalid intensities are not turned into definite predictions', () => {
  const info = eewInfo(report({ areas: [{ scaleFrom: -1, scaleTo: 99, kindCode: '11' }] }));
  assert.equal(info.maxScale, -1); assert.equal(info.plum, false);
  assert.equal(info.maxAbove, false);
});

test('EEW duplicates, older reports and unchanged updates do not replay the alarm', () => {
  const receive = createEEWTracker();
  assert.equal(receive(report(), { now }).sound, true);
  assert.equal(receive(report(), { now }).accepted, false);
  const second = report({ issue: { eventId: 'test-event', serial: '2', time } });
  assert.equal(receive(second, { now }).sound, false);
  assert.equal(receive(report(), { now }).accepted, false);
});

test('stronger predictions and forecast-to-warning escalation can alert again', () => {
  const receive = createEEWTracker();
  receive(report({ isWarning: false }), { now });
  assert.equal(receive(report({ issue: { eventId: 'test-event', serial: '2', time } }), { now }).sound, true);
  assert.equal(receive(report({ issue: { eventId: 'test-event', serial: '3', time }, areas: [{ scaleTo: 50, scaleFrom: 45 }] }), { now }).sound, true);
});

test('history, training, cancellation and stale reports never sound automatically', () => {
  for (const [data, options] of [
    [report(), { now, silent: true }], [report({ test: true }), { now }],
    [report({ cancelled: true }), { now }], [report(), { now: now + 200000 }]
  ]) assert.equal(createEEWTracker()(data, options).sound, false);
});

test('cancellation is read as a cancellation, not as a new quake warning', () => {
  assert.match(eewAnnouncement(report({ cancelled: true })), /取り消されました/);
  assert.match(eewAnnouncement(report({ areas: [{ kindCode: '19', scaleFrom: 45, scaleTo: 45 }] })), /PLUM法/);
});

function alarmHarness(resume) {
  const tones = [], gains = [], statuses = [];
  const parameter = () => ({
    events: [],
    setValueAtTime(value, at) { this.events.push({ method: 'set', value, at }); },
    linearRampToValueAtTime(value, at) { this.events.push({ method: 'ramp', value, at }); }
  });
  class Context {
    state = 'suspended'; currentTime = 10; destination = {};
    async resume() { if (resume) await resume(); this.state = 'running'; }
    createOscillator() {
      const tone = {
        frequency: parameter(), starts: [], stops: [], disconnected: false,
        connect() {}, disconnect() { this.disconnected = true; },
        start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at); }
      };
      tones.push(tone); return tone;
    }
    createGain() {
      const gain = { gain: parameter(), disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
      gains.push(gain); return gain;
    }
  }
  const alarm = createAlarmController({ environment: { AudioContext: Context }, onStatus: info => statuses.push(info) });
  return { alarm, tones, gains, statuses };
}

test('alarm requires activation and plays bounded rising triplets without raising the gain ceiling', async () => {
  const h = alarmHarness(); assert.equal(h.alarm.play(), false);
  assert.equal(await h.alarm.enable(), true); assert.equal(h.alarm.play(), true);
  assert.equal(h.statuses.at(-1).played, 1);
  const tone = h.tones[0], gain = h.gains[0].gain;
  assert.equal(tone.type, 'sawtooth');
  assert.equal(tone.starts.length, 1);
  assert.equal(tone.stops.length, 1);
  assert.ok(Math.abs(tone.starts[0] - 10.02) < 1e-9);
  assert.ok(Math.abs(tone.stops[0] - tone.starts[0] - 2.55) < 1e-9);
  assert.equal(tone.frequency.events.length, 18);
  assert.equal(gain.events.length, 36);
  for (let i = 0; i < 9; i++) {
    const at = tone.starts[0] + Math.floor(i / 3) * 0.85 + (i % 3) * 0.22;
    assert.deepEqual(tone.frequency.events.slice(i * 2, i * 2 + 2), [
      { method: 'set', value: 780, at }, { method: 'ramp', value: 1480, at: at + 0.14 }
    ]);
    assert.deepEqual(gain.events.slice(i * 4, i * 4 + 4), [
      { method: 'set', value: 0, at },
      { method: 'ramp', value: 0.14, at: at + 0.012 },
      { method: 'set', value: 0.14, at: at + 0.065 },
      { method: 'ramp', value: 0, at: at + 0.18 }
    ]);
  }
  assert.ok(gain.events.every(event => event.value >= 0 && event.value <= 0.16));
  assert.ok(gain.events.at(-1).at < tone.stops[0]);
  h.tones[0].onended(); assert.equal(h.statuses.at(-1).phase, 'armed');
  assert.equal(tone.disconnected, true); assert.equal(h.gains[0].disconnected, true);
  h.alarm.disable(); assert.equal(h.alarm.play(), false);
});

test('a new alert replaces the previous sound and late cleanup cannot end the new alert', async () => {
  const h = alarmHarness();
  await h.alarm.enable(); h.alarm.play(); h.alarm.play();
  assert.deepEqual(h.tones[0].stops, [12.57, undefined]);
  assert.equal(h.statuses.at(-1).played, 2);
  h.tones[0].onended();
  assert.equal(h.tones[0].disconnected, true);
  assert.equal(h.gains[0].disconnected, true);
  assert.equal(h.statuses.at(-1).phase, 'playing');
  h.tones[1].onended(); assert.equal(h.statuses.at(-1).phase, 'armed');
});

test('cancellation and OFF stop even a scheduled alarm and release its audio nodes', async () => {
  const h = alarmHarness(); await h.alarm.enable(); h.alarm.play();
  h.alarm.stop();
  assert.equal(h.tones[0].stops.at(-1), undefined);
  assert.equal(h.statuses.at(-1).phase, 'armed');
  h.tones[0].onended();
  h.alarm.play(); h.alarm.disable();
  assert.equal(h.tones[1].stops.at(-1), undefined);
  h.tones[1].onended();
  assert.equal(h.tones[1].disconnected, true);
  assert.equal(h.gains[1].disconnected, true);
  assert.equal(h.statuses.at(-1).phase, 'off');
  assert.equal(h.alarm.play(), false);
});

test('turning OFF during asynchronous audio activation cannot re-enable the alarm', async () => {
  let release;
  const h = alarmHarness(() => new Promise(resolve => { release = resolve; }));
  const enable = h.alarm.enable(); h.alarm.disable(); release();
  assert.equal(await enable, false); assert.equal(h.alarm.play(), false);
});

test('unsupported and blocked audio engines fail explicitly', async () => {
  assert.equal(await createAlarmController({ environment: {} }).enable(), false);
  const h = alarmHarness(async () => { throw new Error('blocked'); });
  assert.equal(await h.alarm.enable(), false); assert.equal(h.statuses.at(-1).phase, 'error');
});

function announcerHarness() {
  const h = alarmHarness();
  const spoken = [], statuses = [];
  const speech = createSpeechController({ environment: {
    speechSynthesis: { getVoices: () => [], addEventListener() {}, cancel() {}, speak: utterance => spoken.push(utterance) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    setTimeout: () => 1, clearTimeout() {}
  }, onStatus: status => statuses.push(status) });
  const announcer = createAlarmAnnouncer({ alarm: h.alarm, speech });
  return { ...h, speech, announcer, spoken, speechStatus: () => statuses.at(-1),
    finishSpeech() { spoken.at(-1).onstart(); spoken.at(-1).onend(); } };
}

test('caution is spoken once after natural alarm completion and before EEW details', async () => {
  const h = announcerHarness(); await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('緊急地震速報。テスト詳細。', { sound: true });
  assert.equal(h.spoken.length, 0);
  h.tones[0].onended();
  assert.equal(h.spoken[0].text, '強い揺れに警戒してください。');
  h.tones[0].onended();
  assert.equal(h.spoken.length, 1);
  h.finishSpeech();
  assert.equal(h.spoken[1].text, '緊急地震速報。');
  h.finishSpeech();
  assert.equal(h.spoken[2].text, 'テスト詳細。');
});

test('EEW updates during the alarm replace details without overlapping speech', async () => {
  const h = announcerHarness(); await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('第1報。', { sound: true });
  h.announcer.announce('第2報。');
  assert.equal(h.tones.length, 1); assert.equal(h.spoken.length, 0);
  h.tones[0].onended(); h.finishSpeech();
  assert.equal(h.spoken[1].text, '第2報。');
  assert.ok(!h.spoken.some(utterance => utterance.text === '第1報。'));
});

test('replaced alarm callbacks cannot release speech or repeat the caution', async () => {
  const h = announcerHarness(); await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('第1報。', { sound: true });
  h.announcer.announce('強まった第2報。', { sound: true });
  h.tones[0].onended();
  assert.equal(h.spoken.length, 0);
  h.tones[1].onended(); h.finishSpeech();
  assert.equal(h.spoken[1].text, '強まった第2報。');
});

test('cancellation suppresses pending caution and still reads the cancellation', async () => {
  const h = announcerHarness(); await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('警報。', { sound: true });
  h.announcer.cancel();
  h.announcer.announce('緊急地震速報は取り消されました。');
  h.tones[0].onended();
  assert.deepEqual(h.spoken.map(utterance => utterance.text), ['緊急地震速報は取り消されました。']);
});

test('alarm OFF cancels queued caution without enabling or replaying anything', async () => {
  const h = announcerHarness(); await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('警報。', { sound: true });
  h.announcer.cancel(); h.alarm.disable(); h.tones[0].onended();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.statuses.at(-1).phase, 'off');
});

test('speech OFF stays OFF when the alarm completes or when disabled midway', async () => {
  const h = announcerHarness(); await h.alarm.enable();
  h.announcer.announce('第1報。', { sound: true }); h.tones[0].onended();
  assert.equal(h.spoken.length, 0); assert.equal(h.speechStatus().enabled, false);
  h.speech.enable();
  h.announcer.announce('第2報。', { sound: true }); h.speech.disable(); h.tones[1].onended();
  assert.equal(h.spoken.length, 0); assert.equal(h.speechStatus().phase, 'off');
});

test('disabled or failed alarms fall back to EEW speech without a false completed-alarm caution', () => {
  const h = announcerHarness(); h.speech.enable();
  h.announcer.announce('テスト速報。', { sound: true });
  assert.deepEqual(h.spoken.map(utterance => utterance.text), ['テスト速報。']);
  const failed = createAlarmAnnouncer({ alarm: { play: () => false, stop() {} }, speech: h.speech });
  failed.announce('失敗時の速報。', { sound: true });
  assert.equal(h.spoken.at(-1).text, '失敗時の速報。');
});

test('alarm test without details produces only the requested caution after completion', async () => {
  const h = announcerHarness(); await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('', { sound: true });
  assert.equal(h.spoken.length, 0); h.tones[0].onended(); h.finishSpeech();
  assert.deepEqual(h.spoken.map(utterance => utterance.text), ['強い揺れに警戒してください。']);
});
