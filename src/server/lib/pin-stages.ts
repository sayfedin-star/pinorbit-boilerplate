export type PinStage = 'NEW' | 'GROWING' | 'MATURE' | 'COOLING' | 'DORMANT';
export type PinAnomaly = 'SPIKE' | 'COOLING' | null;

export function computePinStage(velocity: number, deltaSaves: number, ageDays: number): PinStage {
  if (velocity < 0.5) return 'DORMANT';
  if (velocity < 2 && deltaSaves < 0) return 'COOLING';
  if (ageDays <= 14) return 'NEW';
  if (velocity >= 10) return 'GROWING';
  if (velocity >= 2 && ageDays > 14) return 'MATURE';
  return velocity >= 2 ? 'MATURE' : 'DORMANT';
}

export function computePinAnomaly(deltaSaves: number, velocity: number, daysBetween: number): PinAnomaly {
  if (deltaSaves >= Math.max(20, 3 * velocity * daysBetween)) return 'SPIKE';
  if (deltaSaves <= -Math.max(10, 0.5 * velocity * daysBetween)) return 'COOLING';
  return null;
}
