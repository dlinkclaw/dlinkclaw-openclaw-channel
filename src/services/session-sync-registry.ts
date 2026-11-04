import type { SessionSync } from './session-sync.js';

let instance: SessionSync | null = null;

export function setSessionSync(sync: SessionSync): void {
    instance = sync;
}

export function getSessionSync(): SessionSync | null {
    return instance;
}
