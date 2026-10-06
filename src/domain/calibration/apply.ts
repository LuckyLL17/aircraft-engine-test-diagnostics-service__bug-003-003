import { DomainError, invariant } from '../errors.ts';
import type { Calibration, CalibratedSample, SensorKind, TelemetryEvent } from '../types.ts';

const INSTRUMENT_UNCERTAINTY_RATE = 0.001;
const KELVIN_OFFSET = 273.15;
const KNOWN_SENSORS = new Set<SensorKind>([
  'rpm',
  'fuel-flow',
  'compressor-pressure',
  'turbine-temperature',
  'vibration',
  'oil-temperature',
]);
const TEMPERATURE_SENSORS = new Set<SensorKind>(['turbine-temperature', 'oil-temperature']);

type ValidatedCalibration = Calibration & { channel?: string };

function normalizeCalibrationChannel(channel: string | undefined, index: number): string | undefined {
  if (channel === undefined) return undefined;
  assertCalibration(typeof channel === 'string', index, 'Calibration channel must be a string', { channel });
  const normalized = channel.trim();
  assertCalibration(normalized.length > 0, index, 'Calibration channel must not be blank');
  return normalized;
}

function normalizeEventChannel(channel: unknown, event: TelemetryEvent): string | undefined {
  if (channel === undefined) return undefined;
  if (typeof channel !== 'string') {
    throw new DomainError('INVALID_TELEMETRY', 'Telemetry channel must be a string', 422, { eventId: event.eventId, channel });
  }
  const normalized = channel.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function invalidCalibration(index: number, message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError('INVALID_CALIBRATION', message, 422, { index, ...details });
}

function assertCalibration(condition: unknown, index: number, message: string, details: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw invalidCalibration(index, message, details);
}

function intervalEnd(calibration: Pick<Calibration, 'effectiveToMs'>): number {
  return calibration.effectiveToMs ?? Number.POSITIVE_INFINITY;
}

function overlaps(a: Calibration, b: Calibration): boolean {
  // Effective ranges are half-open: [effectiveFromMs, effectiveToMs).
  return a.effectiveFromMs < intervalEnd(b) && b.effectiveFromMs < intervalEnd(a);
}

function validateCalibration(calibration: Calibration, index: number): ValidatedCalibration {
  assertCalibration(calibration && typeof calibration === 'object', index, 'Calibration must be an object');
  assertCalibration(KNOWN_SENSORS.has(calibration.sensor), index, 'Calibration sensor is unknown', { sensor: calibration.sensor });
  assertCalibration(typeof calibration.version === 'string' && calibration.version.trim().length > 0, index, 'Calibration version is required', { version: calibration.version });

  const channel = normalizeCalibrationChannel(calibration.channel, index);

  assertCalibration(Number.isFinite(calibration.effectiveFromMs) && calibration.effectiveFromMs >= 0, index, 'Calibration effectiveFromMs must be a finite non-negative number', { effectiveFromMs: calibration.effectiveFromMs });
  if (calibration.effectiveToMs !== undefined) {
    assertCalibration(Number.isFinite(calibration.effectiveToMs) && calibration.effectiveToMs > calibration.effectiveFromMs, index, 'Calibration effectiveToMs must be finite and greater than effectiveFromMs', { effectiveFromMs: calibration.effectiveFromMs, effectiveToMs: calibration.effectiveToMs });
  }

  assertCalibration(Number.isFinite(calibration.scale) && calibration.scale > 0, index, 'Calibration scale must be finite and positive', { version: calibration.version, scale: calibration.scale });
  assertCalibration(Number.isFinite(calibration.offset), index, 'Calibration offset must be finite', { version: calibration.version, offset: calibration.offset });
  assertCalibration(Number.isFinite(calibration.uncertainty) && calibration.uncertainty >= 0, index, 'Calibration uncertainty must be finite and non-negative', { version: calibration.version, uncertainty: calibration.uncertainty });

  if (calibration.temperatureCoefficient !== undefined) {
    assertCalibration(Number.isFinite(calibration.temperatureCoefficient), index, 'Temperature coefficient must be finite', { version: calibration.version, temperatureCoefficient: calibration.temperatureCoefficient });
  }
  if (calibration.referenceTemperatureC !== undefined) {
    assertCalibration(Number.isFinite(calibration.referenceTemperatureC) && calibration.referenceTemperatureC >= -KELVIN_OFFSET, index, 'Reference temperature must be finite and at or above absolute zero', { version: calibration.version, referenceTemperatureC: calibration.referenceTemperatureC });
  }

  const temperatureCoefficient = calibration.temperatureCoefficient ?? 0;
  assertCalibration(temperatureCoefficient === 0 || TEMPERATURE_SENSORS.has(calibration.sensor), index, 'Temperature compensation requires a temperature-measuring sensor', { version: calibration.version, sensor: calibration.sensor });

  return { ...calibration, channel };
}

function validateCalibrations(calibrations: Calibration[]): ValidatedCalibration[] {
  invariant(Array.isArray(calibrations), 'INVALID_CALIBRATION', 'Calibrations must be an array');
  const validated = calibrations.map((calibration, index) => validateCalibration(calibration, index));

  const scopes = new Map<string, ValidatedCalibration[]>();
  for (const calibration of validated) {
    const key = `${calibration.sensor}|${calibration.channel ?? ''}`;
    const scope = scopes.get(key) ?? [];
    scope.push(calibration);
    scopes.set(key, scope);
  }

  for (const scopeCalibrations of scopes.values()) {
    for (let i = 0; i < scopeCalibrations.length; i += 1) {
      for (let j = i + 1; j < scopeCalibrations.length; j += 1) {
        const a = scopeCalibrations[i];
        const b = scopeCalibrations[j];
        if (overlaps(a, b)) {
          throw new DomainError(
            'CALIBRATION_OVERLAP',
            'Overlapping calibration versions have the same sensor and channel specificity',
            422,
            {
              sensor: a.sensor,
              channel: a.channel ?? null,
              versions: [a.version, b.version],
              effectiveRanges: [
                { effectiveFromMs: a.effectiveFromMs, effectiveToMs: a.effectiveToMs ?? null },
                { effectiveFromMs: b.effectiveFromMs, effectiveToMs: b.effectiveToMs ?? null },
              ],
            },
          );
        }
      }
    }
  }

  return validated;
}

function covers(calibration: Calibration, sampleTimeMs: number): boolean {
  return sampleTimeMs >= calibration.effectiveFromMs && sampleTimeMs < intervalEnd(calibration);
}

function chooseCalibration(event: TelemetryEvent, calibrations: ValidatedCalibration[]): ValidatedCalibration {
  const eventChannel = normalizeEventChannel(event.channel, event);
  const covering = calibrations.filter(
    (calibration) => calibration.sensor === event.sensor
      && (calibration.channel === undefined || calibration.channel === eventChannel)
      && covers(calibration, event.sampleTimeMs),
  );

  const channelSpecific = eventChannel === undefined
    ? []
    : covering.filter((calibration) => calibration.channel === eventChannel);
  const candidates = channelSpecific.length > 0
    ? channelSpecific
    : covering.filter((calibration) => calibration.channel === undefined);

  if (candidates.length === 0) {
    throw new DomainError('CALIBRATION_MISSING', 'No calibration covers telemetry sample', 422, {
      eventId: event.eventId,
      sampleTimeMs: event.sampleTimeMs,
      sensor: event.sensor,
      channel: eventChannel ?? null,
    });
  }

  if (candidates.length > 1) {
    throw new DomainError('CALIBRATION_OVERLAP', 'Multiple calibration versions cover telemetry sample', 422, {
      eventId: event.eventId,
      sampleTimeMs: event.sampleTimeMs,
      sensor: event.sensor,
      channel: eventChannel ?? null,
      versions: candidates.map((calibration) => calibration.version),
    });
  }

  return candidates[0];
}

function temperatureCorrection(event: TelemetryEvent, calibration: Calibration): number {
  const coefficient = calibration.temperatureCoefficient ?? 0;
  if (coefficient === 0) return 0;

  const referenceTemperatureC = calibration.referenceTemperatureC ?? 20;
  const measuredTemperature = event.unit === 'C'
    ? event.value
    : event.unit === 'K'
      ? event.value - KELVIN_OFFSET
      : (() => {
        throw new DomainError('INVALID_TELEMETRY_UNIT', 'Temperature compensation requires a Celsius or Kelvin measurement', 422, {
          eventId: event.eventId,
          sensor: event.sensor,
          unit: event.unit,
        });
      })();

  return coefficient * (measuredTemperature - referenceTemperatureC);
}

function combineUncertainty(event: TelemetryEvent, calibration: Calibration): number {
  const calibrationUncertainty = calibration.uncertainty;
  const instrumentUncertainty = Math.abs(event.value * calibration.scale) * INSTRUMENT_UNCERTAINTY_RATE;
  // Independent random and calibration contributions are combined in quadrature.
  return Math.hypot(calibrationUncertainty, instrumentUncertainty);
}

export function calibrateTelemetry(events: TelemetryEvent[], calibrations: Calibration[]): CalibratedSample[] {
  invariant(Array.isArray(events), 'INVALID_TELEMETRY', 'Telemetry events must be an array');
  const validatedCalibrations = validateCalibrations(calibrations);
  const result: CalibratedSample[] = [];

  for (const event of events) {
    const calibration = chooseCalibration(event, validatedCalibrations);
    const calibratedValue = event.value * calibration.scale + calibration.offset + temperatureCorrection(event, calibration);
    const uncertainty = combineUncertainty(event, calibration);

    if (!Number.isFinite(calibratedValue) || !Number.isFinite(uncertainty)) {
      throw new DomainError('CALIBRATION_OVERFLOW', 'Calibrated telemetry is not finite', 422, { eventId: event.eventId });
    }

    result.push({ ...event, calibratedValue, uncertainty, calibrationVersion: calibration.version });
  }

  return result;
}
