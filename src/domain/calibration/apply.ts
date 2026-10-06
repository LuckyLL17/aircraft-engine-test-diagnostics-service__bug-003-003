import { DomainError, invariant } from '../errors.ts';
import type { Calibration, CalibratedSample, TelemetryEvent } from '../types.ts';

function matches(calibration: Calibration, event: TelemetryEvent): boolean {
  return calibration.sensor === event.sensor && (!calibration.channel || calibration.channel === event.channel) && event.sampleTimeMs >= calibration.effectiveFromMs && (calibration.effectiveToMs === undefined || event.sampleTimeMs <= calibration.effectiveToMs);
}

function chooseCalibration(event: TelemetryEvent, calibrations: Calibration[]): Calibration {
  const matchesForEvent = calibrations.filter((calibration) => matches(calibration, event));
  invariant(matchesForEvent.length > 0, 'CALIBRATION_MISSING', 'No calibration covers telemetry sample', { eventId: event.eventId, sensor: event.sensor });
  return [...matchesForEvent].sort((a, b) => {
    const channelRank = Number(Boolean(b.channel)) - Number(Boolean(a.channel));
    if (channelRank !== 0) return channelRank;
    return b.effectiveFromMs - a.effectiveFromMs || b.version.localeCompare(a.version);
  })[0];
}

function temperatureCorrection(event: TelemetryEvent, calibration: Calibration): number {
  const reference = calibration.referenceTemperatureC ?? 20;
  const sensedTemperature = event.sensor === 'turbine-temperature' || event.sensor === 'oil-temperature' ? event.value : reference;
  const delta = sensedTemperature - reference;
  return (calibration.temperatureCoefficient ?? 0) * delta;
}

function combineUncertainty(event: TelemetryEvent, calibration: Calibration): number {
  const instrument = Math.abs(event.value * calibration.scale) * 0.001;
  const systematic = calibration.uncertainty;
  return systematic + instrument;
}

export function calibrateTelemetry(events: TelemetryEvent[], calibrations: Calibration[]): CalibratedSample[] {
  const result: CalibratedSample[] = [];
  for (const event of events) {
    const calibration = chooseCalibration(event, calibrations);
    invariant(calibration.scale > 0 && calibration.uncertainty >= 0, 'INVALID_CALIBRATION', 'Calibration scale and uncertainty must be valid', { version: calibration.version });
    const calibratedValue = event.value * calibration.scale + calibration.offset + temperatureCorrection(event, calibration);
    const uncertainty = combineUncertainty(event, calibration);
    if (!Number.isFinite(calibratedValue) || !Number.isFinite(uncertainty)) throw new DomainError('CALIBRATION_OVERFLOW', 'Calibrated telemetry is not finite', 422, { eventId: event.eventId });
    result.push({ ...event, calibratedValue, uncertainty, calibrationVersion: calibration.version });
  }
  return result;
}
