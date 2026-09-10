export interface MediaStorageCapacityInput {
  totalBytes: number;
  freeBytes: number;
  minimumFreeBytes: number;
  minimumFreePercent: number;
  requiredBytes?: number;
}

export interface MediaStorageCapacityDecision {
  allowed: boolean;
  projectedFreeBytes: number;
  projectedFreePercent: number;
  byteReserveSatisfied: boolean;
  percentReserveSatisfied: boolean;
}

export class MediaStorageCapacityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaStorageCapacityPolicyError";
  }
}

export function evaluateMediaStorageCapacity(
  input: MediaStorageCapacityInput,
): MediaStorageCapacityDecision {
  const totalBytes = nonNegativeFinite(input.totalBytes, "totalBytes");
  const freeBytes = nonNegativeFinite(input.freeBytes, "freeBytes");
  const minimumFreeBytes = nonNegativeFinite(input.minimumFreeBytes, "minimumFreeBytes");
  const minimumFreePercent = boundedPercent(input.minimumFreePercent, "minimumFreePercent");
  const requiredBytes = nonNegativeFinite(input.requiredBytes ?? 0, "requiredBytes");

  if (freeBytes > totalBytes) {
    throw new MediaStorageCapacityPolicyError("freeBytes cannot exceed totalBytes");
  }

  const projectedFreeBytes = Math.max(0, freeBytes - requiredBytes);
  const projectedFreePercent =
    totalBytes > 0 ? Math.max(0, Math.min(100, (projectedFreeBytes / totalBytes) * 100)) : 0;
  const byteReserveSatisfied = projectedFreeBytes >= minimumFreeBytes;
  const percentReserveSatisfied = projectedFreePercent >= minimumFreePercent;

  return {
    allowed: byteReserveSatisfied && percentReserveSatisfied && requiredBytes <= freeBytes,
    projectedFreeBytes,
    projectedFreePercent,
    byteReserveSatisfied,
    percentReserveSatisfied,
  };
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new MediaStorageCapacityPolicyError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function boundedPercent(value: number, name: string): number {
  const parsed = nonNegativeFinite(value, name);
  if (parsed > 100) {
    throw new MediaStorageCapacityPolicyError(`${name} must be between 0 and 100`);
  }
  return parsed;
}
