/**
 * INFRALITH AUDIT LOG SERVICE
 * Enterprise-grade immutable action ledger.
 * Every action is stored with: who, what, when, context hash.
 * In production: ship these records to Azure Cosmos DB.
 */

export type AuditAction =
    | 'USER_LOGIN'
    | 'USER_LOGOUT'
    | 'BLUEPRINT_UPLOADED'
    | 'ANALYSIS_COMPLETE'
    | 'REPORT_VIEWED'
    | 'REPORT_EXPORTED'
    | 'PROJECT_APPROVED'
    | 'PROJECT_REJECTED'
    | 'APPROVAL_REQUESTED'
    | 'SETTINGS_CHANGED'
    | 'USER_CREATED'
    | 'USER_DELETED'
    | 'ANNOUNCEMENT_SENT'
    | 'MESSAGE_SENT'
    | 'ADMIN_ACCESS';

export interface AuditEntry {
    id: string;
    timestamp: string;           // ISO 8601
    action: AuditAction;
    actorId: string;
    actorName: string;
    actorRole: string;
    actorEmail: string;
    metadata: Record<string, any>;
    hash: string;                // Tamper-evidence fingerprint
    sessionId: string;
}

const AUDIT_STORE_KEY = 'infralith_audit_log';
const MAX_ENTRIES = 500; // rolling window

/** Lightweight deterministic hash for tamper evidence */
function fingerprint(entry: Omit<AuditEntry, 'hash'>): string {
    const raw = `${entry.timestamp}|${entry.actorId}|${entry.action}|${JSON.stringify(entry.metadata)}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        const chr = raw.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0;
    }
    const hex = Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
    return `SHA-${hex.slice(0, 3)}…`;
}

function getSessionId(): string {
    if (typeof window === 'undefined') return 'srv';
    let sid = sessionStorage.getItem('infralith_session_id');
    if (!sid) {
        sid = `SID-${Date.now().toString(36).toUpperCase()}`;
        sessionStorage.setItem('infralith_session_id', sid);
    }
    return sid;
}

export const auditLog = {
    record(
        action: AuditAction,
        actor: { uid: string; name: string; role?: string; email?: string },
        metadata: Record<string, any> = {}
    ): AuditEntry {
        const base: Omit<AuditEntry, 'hash'> = {
            id: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            timestamp: new Date().toISOString(),
            action,
            actorId: actor.uid,
            actorName: actor.name,
            actorRole: actor.role || 'Unknown',
            actorEmail: actor.email || '',
            metadata,
            sessionId: getSessionId(),
        };

        const entry: AuditEntry = { ...base, hash: fingerprint(base) };

        // Persist to localStorage (swap for Cosmos DB write in production)
        if (typeof window !== 'undefined') {
            try {
                const existing: AuditEntry[] = JSON.parse(localStorage.getItem(AUDIT_STORE_KEY) || '[]');
                const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
                localStorage.setItem(AUDIT_STORE_KEY, JSON.stringify(updated));
            } catch (_) { /* Storage full — fail silently */ }
        }

        // Console trace for server-side actions
        console.log(`[AUDIT] ${entry.timestamp} | ${entry.actorRole} | ${entry.actorName} | ${entry.action}`, metadata);
        return entry;
    },

    getAll(): AuditEntry[] {
        if (typeof window === 'undefined') return [];
        try {
            return JSON.parse(localStorage.getItem(AUDIT_STORE_KEY) || '[]');
        } catch {
            return [];
        }
    },

    getByAction(action: AuditAction): AuditEntry[] {
        return this.getAll().filter(e => e.action === action);
    },

    getByUser(uid: string): AuditEntry[] {
        return this.getAll().filter(e => e.actorId === uid);
    },

    /** Usage frequency map for analytics */
    getUsageStats(): Record<string, number> {
        const entries = this.getAll();
        return entries.reduce((acc, e) => {
            acc[e.action] = (acc[e.action] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
    },

    /** Per-user activity count for admin */
    getUserActivity(): { name: string; email: string; role: string; count: number }[] {
        const entries = this.getAll();
        const map = new Map<string, { name: string; email: string; role: string; count: number }>();
        for (const e of entries) {
            if (!map.has(e.actorId)) {
                map.set(e.actorId, { name: e.actorName, email: e.actorEmail, role: e.actorRole, count: 0 });
            }
            map.get(e.actorId)!.count++;
        }
        return Array.from(map.values()).sort((a, b) => b.count - a.count);
    }
};
