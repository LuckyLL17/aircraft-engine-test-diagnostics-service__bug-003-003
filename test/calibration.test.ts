import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateTelemetry, validateCalibrations } from '../src/domain/calibration/apply.ts';
import { DomainError } from '../src/domain/errors.ts';
import type { Calibration, TelemetryEvent } from '../src/domain/types.ts';

function cal(overrides: Partial<Calibration> & Pick<Calibration, 'sensor' | 'version'>): Calibration {
  return { effectiveFromMs: 0, scale: 1, offset: 0, uncertainty: 0, ...overrides };
}

function event(overrides: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'sensor'>): TelemetryEvent {
  return { runId: 'run-1', eventId: `evt-${Math.random().toString(36).slice(2)}`, sampleTimeMs: 100, receivedTimeMs: 120, sequence: 0, value: 1, unit: 'rpm', ...overrides };
}

function expectDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal((error as DomainError).code, code);
    return true;
  });
}

test('channel-specific calibration wins over generic calibration for the same sample', () => {
  const calibrations = [
    cal({ sensor: 'vibration', version: 'generic-v1' }),
    cal({ sensor: 'vibration', channel: 'ch-a', version: 'channel-v1', uncertainty: 0 }),
  ];
  const samples = calibrateTelemetry([
    event({ sensor: 'vibration', channel: 'ch-a', value: 5, unit: 'g' }),
    event({ sensor: 'vibration', channel: 'ch-b', value: 5, unit: 'g' }),
    event({ sensor: 'vibration', value: 5, unit: 'g' }),
  ], calibrations);
  assert.deepEqual(samples.map((s) => s.calibrationVersion), ['channel-v1', 'generic-v1', 'generic-v1']);
});

test('nested generic and channel-specific validity ranges are allowed (not treated as overlap)', () => {
  assert.doesNotThrow(() => validateCalibrations([
    cal({ sensor: 'vibration', version: 'generic-v1', effectiveFromMs: 0 }),
    cal({ sensor: 'vibration', channel: 'ch-a', version: 'channel-v1', effectiveFromMs: 50 }),
  ]));
});

test('cross-version ranges select the version in effect at the sample time', () => {
  const calibrations = [
    cal({ sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 200 }),
    cal({ sensor: 'rpm', version: 'v2', effectiveFromMs: 200 }),
  ];
  const samples = calibrateTelemetry([
    event({ sensor: 'rpm', sampleTimeMs: 0 }),
    event({ sensor: 'rpm', sampleTimeMs: 199 }),
    event({ sensor: 'rpm', sampleTimeMs: 200 }),
    event({ sensor: 'rpm', sampleTimeMs: 500 }),
  ], calibrations);
  assert.deepEqual(samples.map((s) => s.calibrationVersion), ['v1', 'v1', 'v2', 'v2']);
});

test('effective interval is half-open: sample exactly at the upper boundary uses the next version', () => {
  const calibrations = [
    cal({ sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 200 }),
    cal({ sensor: 'rpm', version: 'v2', effectiveFromMs: 200, effectiveToMs: 400 }),
  ];
  const atBoundary = calibrateTelemetry([event({ sensor: 'rpm', sampleTimeMs: 200 })], calibrations);
  assert.equal(atBoundary[0].calibrationVersion, 'v2');
});

test('adjacent half-open versions do not count as overlap', () => {
  assert.doesNotThrow(() => validateCalibrations([
    cal({ sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 200 }),
    cal({ sensor: 'rpm', version: 'v2', effectiveFromMs: 200 }),
  ]));
});

test('missing calibration at sample time is a CALIBRATION_MISSING domain error', () => {
  const calibrations = [
    cal({ sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 100 }),
  ];
  expectDomainError(
    () => calibrateTelemetry([event({ sensor: 'rpm', sampleTimeMs: 100 })], calibrations),
    'CALIBRATION_MISSING',
  );
});

test('channel-specific calibration does not silently cover a generic sample', () => {
  const calibrations = [cal({ sensor: 'vibration', channel: 'ch-a', version: 'channel-v1' })];
  expectDomainError(
    () => calibrateTelemetry([event({ sensor: 'vibration' })], calibrations),
    'CALIBRATION_MISSING',
  );
});

test('overlapping same-scope calibrations are a CALIBRATION_OVERLAP error even with no samples', () => {
  const calibrations = [
    cal({ sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 200 }),
    cal({ sensor: 'rpm', version: 'v2', effectiveFromMs: 150, effectiveToMs: 300 }),
  ];
  expectDomainError(() => calibrateTelemetry([], calibrations), 'CALIBRATION_OVERLAP');
});

test('illegal scale cannot be silently bypassed', () => {
  const calibrations = [cal({ sensor: 'rpm', version: 'bad', scale: 0 })];
  expectDomainError(() => calibrateTelemetry([], calibrations), 'INVALID_CALIBRATION');
});

test('illegal effective range (end before start) is rejected up front', () => {
  const calibrations = [cal({ sensor: 'rpm', version: 'bad', effectiveFromMs: 200, effectiveToMs: 200 })];
  expectDomainError(() => calibrateTelemetry([], calibrations), 'INVALID_CALIBRATION');
});

test('duplicate version for the same sensor and channel is rejected', () => {
  const calibrations = [
    cal({ sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 100 }),
    cal({ sensor: 'rpm', version: 'v1', effectiveFromMs: 100 }),
  ];
  expectDomainError(() => calibrateTelemetry([], calibrations), 'INVALID_CALIBRATION');
});

test('temperature correction compares measured Celsius value to the calibration reference', () => {
  const calibrations = [cal({
    sensor: 'turbine-temperature', version: 't-v1',
    scale: 1, offset: 0, temperatureCoefficient: 0.01, referenceTemperatureC: 25,
  })];
  const [sample] = calibrateTelemetry([event({ sensor: 'turbine-temperature', value: 125, unit: 'C' })], calibrations);
  assert.ok(Math.abs(sample.calibratedValue - 126) < 1e-12);
});

test('temperature correction converts Kelvin readings to Celsius before applying the reference', () => {
  const calibrations = [cal({
    sensor: 'turbine-temperature', version: 't-v1',
    temperatureCoefficient: 0.01, referenceTemperatureC: 25,
  })];
  const [sample] = calibrateTelemetry([event({ sensor: 'turbine-temperature', value: 398.15, unit: 'K' })], calibrations);
  // 398.15 K = 125 C -> correction 0.01 * (125 - 25) = 1
  assert.ok(Math.abs(sample.calibratedValue - 399.15) < 1e-9);
});

test('default reference temperature is 20 C', () => {
  const calibrations = [cal({ sensor: 'oil-temperature', version: 't-v1', temperatureCoefficient: 0.01 })];
  const [sample] = calibrateTelemetry([event({ sensor: 'oil-temperature', value: 30, unit: 'C' })], calibrations);
  assert.ok(Math.abs(sample.calibratedValue - 30.1) < 1e-12);
});

test('non-temperature sensors receive no temperature correction', () => {
  const calibrations = [cal({ sensor: 'rpm', version: 'r-v1', temperatureCoefficient: 0.5 })];
  const [sample] = calibrateTelemetry([event({ sensor: 'rpm', value: 1000, unit: 'rpm' })], calibrations);
  assert.equal(sample.calibratedValue, 1000);
});

test('uncertainty combines independent sources by root-sum-square', () => {
  const calibrations = [cal({ sensor: 'rpm', version: 'r-v1', scale: 1, offset: 0, uncertainty: 0.5 })];
  const [sample] = calibrateTelemetry([event({ sensor: 'rpm', value: 1000, unit: 'rpm' })], calibrations);
  // instrument = 1000 * 0.001 = 1; systematic = 0.5; RSS = sqrt(1.25)
  assert.ok(Math.abs(sample.uncertainty - Math.sqrt(1.25)) < 1e-12);
  // Linear addition would give 1.5; make sure the sources were not simply summed.
  assert.ok(sample.uncertainty < 1.5);
});

test('instrument uncertainty is based on the calibrated magnitude including offset', () => {
  const calibrations = [cal({ sensor: 'rpm', version: 'r-v1', scale: 2, offset: 10, uncertainty: 0 })];
  const [sample] = calibrateTelemetry([event({ sensor: 'rpm', value: -100, unit: 'rpm' })], calibrations);
  // |(-100 * 2) + 10| * 0.001 = 0.19, systematic 0
  assert.ok(Math.abs(sample.uncertainty - 0.19) < 1e-12);
});

test('non-finite calibration output is a CALIBRATION_OVERFLOW domain error', () => {
  const calibrations = [cal({ sensor: 'rpm', version: 'r-v1', scale: 1, offset: 0 })];
  expectDomainError(
    () => calibrateTelemetry([event({ sensor: 'rpm', value: Number.POSITIVE_INFINITY, unit: 'rpm' })], calibrations),
    'CALIBRATION_OVERFLOW',
  );
});

test('unique version is selected when generic, channel-specific and cross-version records coexist', () => {
  const calibrations = [
    cal({ sensor: 'vibration', version: 'g-v1', effectiveFromMs: 0, effectiveToMs: 300 }),
    cal({ sensor: 'vibration', version: 'g-v2', effectiveFromMs: 300 }),
    cal({ sensor: 'vibration', channel: 'ch-a', version: 'c-v1', effectiveFromMs: 0, effectiveToMs: 200 }),
    cal({ sensor: 'vibration', channel: 'ch-a', version: 'c-v2', effectiveFromMs: 200 }),
  ];
  const samples = calibrateTelemetry([
    event({ sensor: 'vibration', channel: 'ch-a', sampleTimeMs: 199, value: 1, unit: 'g' }),
    event({ sensor: 'vibration', channel: 'ch-a', sampleTimeMs: 200, value: 1, unit: 'g' }),
    event({ sensor: 'vibration', channel: 'ch-a', sampleTimeMs: 300, value: 1, unit: 'g' }),
    event({ sensor: 'vibration', channel: 'ch-b', sampleTimeMs: 300, value: 1, unit: 'g' }),
    event({ sensor: 'vibration', sampleTimeMs: 300, value: 1, unit: 'g' }),
  ], calibrations);
  assert.deepEqual(samples.map((s) => s.calibrationVersion), ['c-v1', 'c-v2', 'c-v2', 'g-v2', 'g-v2']);
});
