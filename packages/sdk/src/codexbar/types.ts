export interface CodexBarWindow {
	usedPercent: number;
	windowMinutes?: number | null;
	resetsAt?: string | null;
	resetDescription?: string | null;
	nextRegenPercent?: number | null;
}

export interface NamedCodexBarWindow {
	id: string;
	title: string;
	window: CodexBarWindow;
}

export interface CodexBarStatus {
	indicator: string;
	description: string;
	updatedAt?: string;
	url?: string;
}

export interface CodexBarIdentity {
	providerID: string;
	accountEmail: string | null;
	accountOrganization: string | null;
	loginMethod: string;
}

export interface CodexBarUsage {
	primary?: CodexBarWindow | null;
	secondary?: CodexBarWindow | null;
	tertiary?: CodexBarWindow | null;
	extraRateWindows?: NamedCodexBarWindow[] | null;
	updatedAt?: string;
	identity?: CodexBarIdentity;
}

export interface CodexBarCredits {
	remaining: number;
	updatedAt?: string;
}

export interface CodexBarUsageResponse {
	provider: string;
	version?: string;
	source?: string;
	status?: CodexBarStatus;
	usage: CodexBarUsage;
	credits?: CodexBarCredits;
	[key: string]: unknown;
}
