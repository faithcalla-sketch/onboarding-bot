import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  formatLong,
  formatShort,
  isWeekend,
  parseGoLive,
  relativeLabel,
  todayInZone,
  weekdayName,
} from '../src/dates.js';

// A Thursday afternoon in New York — the exact scenario the bot was built for.
const NOW = new Date('2026-08-20T19:00:00Z');
const TZ = 'America/New_York';
const opts = { timezone: TZ, now: NOW };

test('today is resolved in the given timezone', () => {
  assert.equal(todayInZone(TZ, NOW), '2026-08-20');
  // Late evening in New York is already the next day in Manila.
  assert.equal(todayInZone('Asia/Manila', new Date('2026-08-20T19:00:00Z')), '2026-08-21');
});

test('relative words resolve against the team timezone', () => {
  assert.equal(parseGoLive('today', opts), '2026-08-20');
  assert.equal(parseGoLive('tomorrow', opts), '2026-08-21');
  assert.equal(parseGoLive('TOMORROW', opts), '2026-08-21');
  assert.equal(parseGoLive('  tmrw ', opts), '2026-08-21');
});

test('weekday names resolve to the next such day, never today', () => {
  assert.equal(parseGoLive('Friday', opts), '2026-08-21');
  assert.equal(parseGoLive('monday', opts), '2026-08-24');
  assert.equal(parseGoLive('next Monday', opts), '2026-08-24');
  assert.equal(parseGoLive('fri', opts), '2026-08-21');
  // Said on a Thursday, "Thursday" means the one coming, not today.
  assert.equal(parseGoLive('Thursday', opts), '2026-08-27');
});

test('numeric and written dates parse', () => {
  assert.equal(parseGoLive('8/24', opts), '2026-08-24');
  assert.equal(parseGoLive('08/24/2026', opts), '2026-08-24');
  assert.equal(parseGoLive('8-24-26', opts), '2026-08-24');
  assert.equal(parseGoLive('Aug 24', opts), '2026-08-24');
  assert.equal(parseGoLive('August 24, 2026', opts), '2026-08-24');
  assert.equal(parseGoLive('24 August', opts), '2026-08-24');
  assert.equal(parseGoLive('21st Aug', opts), '2026-08-21');
  assert.equal(parseGoLive('2026-08-24', opts), '2026-08-24');
});

test('a yearless date already past rolls into next year', () => {
  // Late January, asked for in August, means next January.
  assert.equal(parseGoLive('1/15', opts), '2027-01-15');
  // ...but a date that only just passed is a typo, not next year.
  assert.equal(parseGoLive('8/18', opts), '2026-08-18');
});

test('Trello date fields arrive as instants and become calendar days', () => {
  assert.equal(parseGoLive('2026-08-24T13:00:00.000Z', opts), '2026-08-24');
  // 00:30 UTC is still the 23rd in New York, and that is the day the setter meant.
  assert.equal(parseGoLive('2026-08-24T00:30:00.000Z', opts), '2026-08-23');
});

test('empty input is not an error, garbage is', () => {
  assert.equal(parseGoLive('', opts), null);
  assert.equal(parseGoLive(null, opts), null);
  assert.equal(parseGoLive('   ', opts), null);
  assert.throws(() => parseGoLive('whenever', opts), /Could not read/);
  assert.throws(() => parseGoLive('99/99', opts), /not a valid month\/day/);
});

test('calendar maths does not drift across month and year ends', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-08-20', '2026-08-24'), 4);
  assert.equal(daysBetween('2026-08-24', '2026-08-20'), -4);
});

test('formatting reads the way a client would say it', () => {
  assert.equal(formatLong('2026-08-21'), 'Friday, August 21, 2026');
  assert.equal(formatShort('2026-08-21'), 'Fri, Aug 21');
  assert.equal(weekdayName('2026-08-21'), 'Friday');
});

test('relative labels', () => {
  assert.equal(relativeLabel('2026-08-20', '2026-08-20'), 'today');
  assert.equal(relativeLabel('2026-08-21', '2026-08-20'), 'tomorrow');
  assert.equal(relativeLabel('2026-08-24', '2026-08-20'), 'in 4 days');
  assert.equal(relativeLabel('2026-08-19', '2026-08-20'), 'yesterday');
  assert.equal(relativeLabel('2026-08-17', '2026-08-20'), '3 days ago');
});

test('weekend detection', () => {
  assert.equal(isWeekend('2026-08-22'), true); // Saturday
  assert.equal(isWeekend('2026-08-23'), true); // Sunday
  assert.equal(isWeekend('2026-08-21'), false); // Friday
});
