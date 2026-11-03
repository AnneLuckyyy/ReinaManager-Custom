export type DiskHealthLevel = "normal" | "attention" | "critical" | "unknown";

export interface DiskHealthIndicators {
	reallocatedSectors: string | null;
	pendingSectors: string | null;
	uncorrectableSectors: string | null;
	nvmeCriticalWarning: string | null;
	nvmeMediaErrors: string | null;
}

export interface DiskHealthDrive {
	id: string;
	model: string;
	driveLetters: string;
	health: DiskHealthLevel;
	healthPercent: number | null;
	temperature: number | null;
	indicators: DiskHealthIndicators;
	indicatorGrowth?: boolean;
}

export interface DiskHealthSnapshot {
	checkedAt: string;
	drives: DiskHealthDrive[];
}
