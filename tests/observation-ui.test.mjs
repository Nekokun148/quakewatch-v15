import test from 'node:test';
import assert from 'node:assert/strict';
import { renderObservationRegions } from '../js/observation-ui.js';
import { acceptsQuakeReport, measuredPoints, selectObservationReport } from '../js/observations.js';

const scaleText = value => ({ 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7' })[value] || '不明';
const report = (time, points = [], name = 'テスト震源') => ({
  issue: { time }, earthquake: { time, hypocenter: { name } }, points
});

function harness() {
  class Element {
    children = [];
    dataset = {};
    text = '';
    style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); } };
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
  }
  const elements = new Map(['regions', 'regionSummary', 'observationMeta'].map(id => [id, new Element()]));
  const document = { body: new Element(), createElement: () => new Element(), getElementById: id => elements.get(id) };
  let current, observation;
  return {
    document,
    get: id => elements.get(id),
    render(data) { renderObservationRegions(data, { document, scaleText, measuredCount: measuredPoints(data.points).length }); },
    receive(data) {
      if (!acceptsQuakeReport(current, data)) return;
      current = data;
      observation = selectObservationReport(observation, data);
      this.render(observation);
    }
  };
}

test('the next quake replaces observed regions, intensities and event metadata', () => {
  const h = harness();
  h.receive(report('2026-10-09T10:00:00+09:00', [{ pref: '東京都', addr: '東京テスト地点', scale: 10 }]));
  assert.match(h.get('regions').textContent, /東京テスト地点震度1/);
  h.receive(report('2026-10-09T10:10:00+09:00', [{ pref: '宮城県', addr: '宮城テスト地点', scale: 40 }], '次のテスト震源'));
  assert.match(h.get('regions').textContent, /宮城テスト地点震度4/);
  assert.doesNotMatch(h.get('regions').textContent, /東京/);
  assert.match(h.get('regionSummary').textContent, /宮城県.*最大震度4/);
  assert.match(h.get('observationMeta').textContent, /次のテスト震源.*10:10:00/);
  assert.equal(h.document.body.dataset.qwObservationRegions, '1');
});

test('all received stations beyond eighty remain visible without invented positions', () => {
  const h = harness();
  const points = Array.from({ length: 101 }, (_, index) => ({ code: `test-${index}`, pref: '東京都', addr: `テスト地点${index}`, scale: 10 }));
  h.render(report('2026-10-09T10:00:00+09:00', points));
  assert.equal(h.get('regions').children.length, 101);
  assert.match(h.get('regions').textContent, /テスト地点100震度1/);
  assert.match(h.get('observationMeta').textContent, /地図0地点・位置未確認101地点/);
  assert.equal(measuredPoints(points).length, 0);
});

test('duplicate stations retain the highest intensity and corresponding color', () => {
  const h = harness();
  h.render(report('2026-10-09T10:00:00+09:00', [10, 40, 20].map(scale => ({ code: 'test', pref: '東京都', addr: 'テスト地点', scale }))));
  const rows = h.get('regions').children;
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /震度4/);
  assert.equal(rows[0].style.values.get('--intensity-color'), '#fb923c');
});

test('area reports are labelled separately from station observations', () => {
  const h = harness();
  h.render(report('2026-10-09T10:00:00+09:00', [{ pref: '東京都', addr: '東京テスト地域', scale: 30, isArea: true }]));
  assert.match(h.get('regions').textContent, /東京テスト地域（地域）震度3/);
  assert.match(h.get('regionSummary').textContent, /0地点・1地域.*最大震度3/);
  assert.match(h.get('observationMeta').textContent, /地図0地点/);
});

test('unknown intensity is never rendered as a definite numeric observation', () => {
  const h = harness();
  h.render(report('2026-10-09T10:00:00+09:00', [{ pref: '東京都', addr: 'テスト地点', scale: -1 }]));
  assert.match(h.get('regions').textContent, /震度未確認/);
  assert.doesNotMatch(h.get('regions').textContent, /震度-1/);
  assert.equal(h.get('regionSummary').children.length, 0);
});

test('same-event hypocenter-only updates preserve received observations', () => {
  const first = report('2026-10-09T10:00:00+09:00', [{ pref: '東京都', addr: 'テスト地点', scale: 20 }]);
  const incoming = { ...report('2026-10-09T10:00:00+09:00'), issue: { time: '2026-10-09T10:01:00+09:00' } };
  assert.equal(selectObservationReport(first, incoming), first);
  const h = harness(); h.receive(first); h.receive(incoming);
  assert.match(h.get('regions').textContent, /テスト地点震度2/);
});

test('a new event without observations clears the previous list and marks pending', () => {
  const h = harness();
  h.receive(report('2026-10-09T10:00:00+09:00', [{ pref: '東京都', addr: '前のテスト地点', scale: 20 }]));
  h.receive(report('2026-10-09T10:10:00+09:00', [], '次のテスト震源'));
  assert.match(h.get('regions').textContent, /この地震の観測震度は発表待ち/);
  assert.doesNotMatch(h.get('regions').textContent, /前のテスト地点/);
  assert.equal(h.get('regionSummary').children.length, 0);
  assert.match(h.get('observationMeta').textContent, /次のテスト震源/);
});

test('unknown event times do not merge unrelated observations', () => {
  const current = report('', [{ pref: '東京都', addr: 'テスト地点', scale: 20 }]);
  const incoming = report('');
  assert.equal(selectObservationReport(current, incoming), incoming);
});

test('older reports cannot replace the current regional intensity list', () => {
  const h = harness();
  h.receive(report('2026-10-09T10:10:00+09:00', [{ pref: '宮城県', addr: '新しいテスト地点', scale: 40 }]));
  h.receive(report('2026-10-09T10:00:00+09:00', [{ pref: '東京都', addr: '古いテスト地点', scale: 10 }]));
  assert.match(h.get('regions').textContent, /新しいテスト地点震度4/);
  assert.doesNotMatch(h.get('regions').textContent, /古いテスト地点/);
});

test('region names are inserted as text, never interpreted as HTML', () => {
  const h = harness();
  h.render(report('2026-10-09T10:00:00+09:00', [{ pref: '東京都', addr: '<img src=x onerror=alert(1)>', scale: 10 }]));
  const name = h.get('regions').children[0].children[0];
  assert.match(name.textContent, /<img/);
  assert.equal(name.children.length, 0);
});
