import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseVibration } from '../src/domain/vibration/fuse.ts';
import { estimateRemainingLife } from '../src/domain/life/estimate.ts';
import { evaluatePerformance } from '../src/domain/performance/evaluate.ts';
import { replayTelemetry } from '../src/domain/timeline/replay.ts';
import { calibrateTelemetry } from '../src/domain/calibration/apply.ts';

test('replay is deterministic and removes duplicate event ids', () => {
  const events = [
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
    { runId: 'run-1', eventId: 'a', sampleTimeMs: 1, receivedTimeMs: 3, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
  ] as any;
  assert.deepEqual(replayTelemetry(events).map((item) => item.eventId), ['a', 'b']);
});

test('calibration prefers the channel-specific version and uses half-open effective ranges', () => {
  const baseEvent = { runId: 'run-1', receivedTimeMs: 10, sequence: 0, value: 100, unit: 'rpm' };
  const events = [
    { ...baseEvent, eventId: 'a', sampleTimeMs: 100, sensor: 'rpm', channel: 'A' },
    { ...baseEvent, eventId: 'b', sampleTimeMs: 200, sensor: 'rpm', channel: 'A' },
    { ...baseEvent, eventId: 'c', sampleTimeMs: 200, sensor: 'rpm', channel: 'B' },
  ] as any;
  const calibrations = [
    { sensor: 'rpm', version: 'generic-v1', effectiveFromMs: 0, effectiveToMs: 200, scale: 1, offset: 0, uncertainty: 1 },
    { sensor: 'rpm', version: 'generic-v2', effectiveFromMs: 200, scale: 1, offset: 0, uncertainty: 1 },
    { sensor: 'rpm', channel: 'A', version: 'channel-v1', effectiveFromMs: 0, effectiveToMs: 100, scale: 1, offset: 0, uncertainty: 1 },
    { sensor: 'rpm', channel: 'A', version: 'channel-v2', effectiveFromMs: 100, scale: 2, offset: 0, uncertainty: 1 },
  ] as any;

  assert.deepEqual(calibrateTelemetry(events, calibrations).map((sample) => [sample.eventId, sample.calibrationVersion]), [
    ['a', 'channel-v2'],
    ['b', 'channel-v2'],
    ['c', 'generic-v2'],
  ]);
});

test('calibration reports missing and overlapping effective ranges as domain errors', () => {
  const event = { runId: 'run-1', eventId: 'a', sampleTimeMs: 300, receivedTimeMs: 10, sequence: 0, sensor: 'rpm', value: 1, unit: 'rpm' } as any;
  assert.throws(() => calibrateTelemetry([event], [{ sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 200, scale: 1, offset: 0, uncertainty: 1 }]), (error: any) => error.code === 'CALIBRATION_MISSING');
  assert.throws(() => calibrateTelemetry([event], [
    { sensor: 'rpm', version: 'v1', effectiveFromMs: 0, effectiveToMs: 300, scale: 1, offset: 0, uncertainty: 1 },
    { sensor: 'rpm', version: 'v2', effectiveFromMs: 200, scale: 1, offset: 0, uncertainty: 1 },
  ]), (error: any) => error.code === 'CALIBRATION_OVERLAP');
});

test('calibration temperature compensation uses the measured value and combines uncertainty in quadrature', () => {
  const event = { runId: 'run-1', eventId: 'a', sampleTimeMs: 0, receivedTimeMs: 10, sequence: 0, sensor: 'oil-temperature', value: 323.15, unit: 'K' } as any;
  const [sample] = calibrateTelemetry([event], [{
    sensor: 'oil-temperature',
    version: 'temp-v1',
    effectiveFromMs: 0,
    scale: 1,
    offset: 0,
    temperatureCoefficient: 0.5,
    referenceTemperatureC: 30,
    uncertainty: 4,
  }]);
  assert.equal(sample.calibratedValue, 323.15 + 10);
  assert.equal(sample.uncertainty, Math.hypot(4, 323.15 * 0.001));
});

test('performance produces physical normalized indicators', () => {
  const result = evaluatePerformance({ rpm: 9_000, fuelFlowKgPerSecond: 2, compressorOutletPressureKpa: 900, turbineInletTemperatureK: 1_000, ambientPressureKpa: 101.3, ambientTemperatureK: 288, inletPressureKpa: 100, referenceRpm: 10_000, referenceTemperatureK: 288, referencePressureKpa: 101.3 });
  assert.ok(result.pressureRatio > 1);
  assert.ok(result.compressorEfficiency >= 0 && result.compressorEfficiency <= 1);
});

test('vibration evidence is grouped by correlated source', () => {
  const result = diagnoseVibration([
    { evidenceId: 'a', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 0, windowEndMs: 100, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'b', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 20, windowEndMs: 80, feature: 'broadband', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'c', sensorId: 's2', sourceGroup: 'g2', windowStartMs: 200, windowEndMs: 300, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 3, amplitude: 2 },
  ]);
  assert.equal(result[0].evidenceIds.length, 2);
});

test('life estimate is reproducible for a fixed seed', () => {
  const input = { initialHealth: { compressorEfficiency: 0.95, turbineFlowCapacity: 0.96, bearingFriction: 0.02, hotSectionMargin: 0.9, elapsedHours: 100, version: 1 }, horizonHours: 10_000, samples: 100, seed: 42, meanDegradationPerHour: 0.0002, deviation: 0.00003, temperatureStress: 0.2, vibrationStress: 0.1, failureThreshold: 0.4, correlation: [[1, 0.3], [0.3, 1]] as [[number, number], [number, number]] };
  assert.deepEqual(estimateRemainingLife(input), estimateRemainingLife(input));
});
