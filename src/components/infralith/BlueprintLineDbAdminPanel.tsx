'use client';

import { useEffect, useMemo, useState } from 'react';
import { Database, RefreshCw, Save, Plus, Trash2, ShieldAlert, Filter } from 'lucide-react';
import type { BlueprintLineRecord } from '@/ai/flows/infralith/blueprint-line-database';
import { getBlueprintLineDatabase } from '@/ai/flows/infralith/blueprint-line-database';
import { useAppContext } from '@/contexts/app-context';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type DbPayload = {
  records: BlueprintLineRecord[];
  source: 'cosmos' | 'default';
  writable: boolean;
  configured: boolean;
  updatedAt: string;
  schemaVersion: number;
  updatedBy?: {
    id?: string;
    name?: string;
    email?: string;
    role?: string;
  } | null;
  error?: string;
};

type Category = BlueprintLineRecord['category'];
type WallGraphRole = BlueprintLineRecord['wallGraphRole'];
type OpeningSignal = NonNullable<BlueprintLineRecord['openingSignal']>;

const CATEGORY_OPTIONS: Category[] = [
  'structural',
  'opening',
  'annotation',
  'reference',
  'circulation',
  'services',
  'site',
  'construction',
];
const WALL_GRAPH_OPTIONS: WallGraphRole[] = ['candidate', 'context', 'exclude'];
const OPENING_OPTIONS: OpeningSignal[] = ['door', 'window', 'generic'];

const toAliasString = (aliases?: string[]) => (Array.isArray(aliases) ? aliases.join(', ') : '');
const fromAliasString = (value: string): string[] | undefined => {
  const aliases = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return aliases.length > 0 ? aliases : undefined;
};

const newRecordTemplate = (index: number): BlueprintLineRecord => ({
  id: `line-${index}`,
  label: `New line ${index}`,
  category: 'reference',
  cue: 'visual cue',
  meaning: 'semantic meaning',
  caution: 'validation caution',
  aliases: [],
  promptPriority: index,
  wallGraphRole: 'exclude',
});

const sortByPriority = (records: BlueprintLineRecord[]): BlueprintLineRecord[] =>
  [...records].sort((a, b) => a.promptPriority - b.promptPriority || a.id.localeCompare(b.id));

const hasDuplicates = (ids: string[]) => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
};

const validateRecords = (records: BlueprintLineRecord[]): string | null => {
  if (!Array.isArray(records) || records.length === 0) return 'At least one line rule is required.';
  const ids = records.map((record) => String(record.id || '').trim()).filter(Boolean);
  if (ids.length !== records.length) return 'Every line must have a non-empty id.';
  if (hasDuplicates(ids)) return 'Line ids must be unique.';
  for (const record of records) {
    if (!record.label?.trim()) return `Label is missing for ${record.id}.`;
    if (!record.cue?.trim() || !record.meaning?.trim() || !record.caution?.trim()) {
      return `Cue/meaning/caution cannot be empty for ${record.id}.`;
    }
    if (!Number.isFinite(record.promptPriority) || record.promptPriority < 1) {
      return `promptPriority must be >= 1 for ${record.id}.`;
    }
  }
  return null;
};

export default function BlueprintLineDbAdminPanel() {
  const { user } = useAppContext();
  const { toast } = useToast();
  const isAdmin = user?.role === 'Admin';

  const [records, setRecords] = useState<BlueprintLineRecord[]>([]);
  const [loadedRecords, setLoadedRecords] = useState<BlueprintLineRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<'all' | Category>('all');
  const [meta, setMeta] = useState<Pick<DbPayload, 'source' | 'writable' | 'configured' | 'updatedAt' | 'schemaVersion' | 'updatedBy'> | null>(null);

  const loadDb = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/infralith/blueprint-line-db', {
        method: 'GET',
        credentials: 'include',
      });
      const payload: DbPayload = await res.json().catch(() => ({ records: [], source: 'default', writable: false, configured: false, updatedAt: new Date().toISOString(), schemaVersion: 1 }));
      if (!res.ok) {
        throw new Error(payload?.error || `Failed to load line DB (status ${res.status})`);
      }
      const sorted = sortByPriority(payload.records || []);
      setRecords(sorted);
      setLoadedRecords(sorted);
      setMeta({
        source: payload.source,
        writable: payload.writable,
        configured: payload.configured,
        updatedAt: payload.updatedAt,
        schemaVersion: payload.schemaVersion,
        updatedBy: payload.updatedBy || null,
      });
    } catch (error) {
      const fallback = sortByPriority(getBlueprintLineDatabase());
      setRecords(fallback);
      setLoadedRecords(fallback);
      setMeta({
        source: 'default',
        writable: false,
        configured: false,
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
        updatedBy: null,
      });
      toast({
        variant: 'destructive',
        title: 'Line DB load failed',
        description: error instanceof Error ? error.message : 'Could not load blueprint line database.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadDb();
  }, []);

  const isDirty = useMemo(() => JSON.stringify(records) !== JSON.stringify(loadedRecords), [records, loadedRecords]);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((record) => {
      if (filterCategory !== 'all' && record.category !== filterCategory) return false;
      if (!q) return true;
      const haystack = `${record.id} ${record.label} ${record.category} ${record.cue} ${record.meaning} ${(record.aliases || []).join(' ')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [records, search, filterCategory]);

  const updateRecord = <K extends keyof BlueprintLineRecord>(
    targetId: string,
    key: K,
    value: BlueprintLineRecord[K]
  ) => {
    setRecords((prev) =>
      prev.map((record) => (record.id === targetId ? { ...record, [key]: value } : record))
    );
  };

  const handleSave = async () => {
    if (!isAdmin) return;
    if (!meta?.writable) {
      toast({
        variant: 'destructive',
        title: 'DB is read-only',
        description: 'Cosmos store is not configured for writing.',
      });
      return;
    }

    const errorMessage = validateRecords(records);
    if (errorMessage) {
      toast({ variant: 'destructive', title: 'Validation failed', description: errorMessage });
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        records: sortByPriority(records).map((record) => ({
          ...record,
          id: record.id.trim(),
          label: record.label.trim(),
          cue: record.cue.trim(),
          meaning: record.meaning.trim(),
          caution: record.caution.trim(),
          aliases: Array.isArray(record.aliases) ? record.aliases.map((alias) => alias.trim()).filter(Boolean) : undefined,
          promptPriority: Math.max(1, Math.round(record.promptPriority)),
          openingSignal: record.openingSignal || undefined,
        })),
      };

      const res = await fetch('/api/infralith/blueprint-line-db', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: DbPayload = await res.json().catch(() => ({} as DbPayload));
      if (!res.ok) {
        throw new Error(body?.error || `Failed to save (status ${res.status})`);
      }

      const sorted = sortByPriority(body.records || payload.records);
      setRecords(sorted);
      setLoadedRecords(sorted);
      setMeta((prev) => ({
        source: body.source || prev?.source || 'cosmos',
        writable: prev?.writable ?? true,
        configured: prev?.configured ?? true,
        updatedAt: body.updatedAt || new Date().toISOString(),
        schemaVersion: body.schemaVersion || prev?.schemaVersion || 1,
        updatedBy: body.updatedBy || null,
      }));
      toast({ title: 'Saved', description: 'Blueprint line database updated successfully.' });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Could not save blueprint line DB.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const cardCountByCategory = useMemo(() => {
    const count: Record<string, number> = {};
    for (const record of records) {
      count[record.category] = (count[record.category] || 0) + 1;
    }
    return count;
  }, [records]);

  if (!isAdmin) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
            <ShieldAlert className="h-5 w-5 text-red-500" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Blueprint Line DB Admin</h1>
            <p className="text-sm text-slate-500 font-semibold">Admin role required for editing.</p>
          </div>
        </div>
        <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5 text-sm font-medium text-amber-700 dark:text-amber-300">
          You currently have <span className="font-black">{user?.role || 'Unknown'}</span> role. Switch to Admin to manage line semantics used in blueprint-to-3D generation.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1100px] mx-auto space-y-6 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-2xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center">
            <Database className="h-5 w-5 text-indigo-500" />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Blueprint Line DB Admin</h1>
            <p className="text-sm text-slate-500 font-semibold">Edit canonical line semantics used by prompt and opening recovery.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-xl font-bold" onClick={() => void loadDb()} disabled={isLoading || isSaving}>
            <RefreshCw className={cn('h-4 w-4 mr-2', isLoading ? 'animate-spin' : '')} />
            Reload
          </Button>
          <Button variant="outline" className="rounded-xl font-bold" onClick={() => setRecords(loadedRecords)} disabled={!isDirty || isSaving}>
            Reset Changes
          </Button>
          <Button variant="outline" className="rounded-xl font-bold" onClick={() => setRecords(sortByPriority(getBlueprintLineDatabase()))} disabled={isSaving}>
            Load Defaults
          </Button>
          <Button className="rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold" onClick={handleSave} disabled={!isDirty || isLoading || isSaving}>
            <Save className={cn('h-4 w-4 mr-2', isSaving ? 'animate-spin' : '')} />
            {isSaving ? 'Saving...' : 'Save to DB'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="rounded-full px-3 py-1 text-xs font-bold">Source: {meta?.source || 'unknown'}</Badge>
        <Badge variant="outline" className="rounded-full px-3 py-1 text-xs font-bold">Writable: {meta?.writable ? 'yes' : 'no'}</Badge>
        <Badge variant="outline" className="rounded-full px-3 py-1 text-xs font-bold">Configured: {meta?.configured ? 'yes' : 'no'}</Badge>
        <Badge variant="outline" className="rounded-full px-3 py-1 text-xs font-bold">Schema v{meta?.schemaVersion || 1}</Badge>
        <Badge variant="outline" className="rounded-full px-3 py-1 text-xs font-bold">Rules: {records.length}</Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto_auto] gap-3 items-center">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by id, label, category, cue..."
          className="h-11 rounded-xl border-slate-200 dark:border-slate-700"
        />
        <div className="relative">
          <Filter className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as 'all' | Category)}
            className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-8 text-sm font-semibold"
          >
            <option value="all">All categories</option>
            {CATEGORY_OPTIONS.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          className="h-11 rounded-xl font-bold"
          onClick={() =>
            setRecords((prev) => {
              const nextIndex = prev.length + 1;
              return sortByPriority([...prev, newRecordTemplate(nextIndex)]);
            })
          }
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Line
        </Button>
        <div className="text-xs font-semibold text-slate-500">
          Showing {filteredRecords.length}/{records.length}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {CATEGORY_OPTIONS.map((category) => (
          <Badge key={category} variant="secondary" className="rounded-full px-3 py-1 text-xs font-bold">
            {category}: {cardCountByCategory[category] || 0}
          </Badge>
        ))}
      </div>

      {isLoading ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-sm font-semibold text-slate-500">
          Loading blueprint line DB...
        </div>
      ) : (
        <div className="space-y-4">
          {filteredRecords.map((record) => (
            <div key={record.id} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] gap-3">
                <Input
                  value={record.id}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRecords((prev) => prev.map((item) => (item.id === record.id ? { ...item, id: value } : item)));
                  }}
                  placeholder="id"
                  className="h-10 rounded-xl font-mono text-xs"
                />
                <Input
                  value={record.label}
                  onChange={(e) => updateRecord(record.id, 'label', e.target.value)}
                  placeholder="label"
                  className="h-10 rounded-xl"
                />
                <Button
                  variant="ghost"
                  className="h-10 rounded-xl text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20"
                  onClick={() => setRecords((prev) => prev.filter((item) => item.id !== record.id))}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">category</p>
                  <select
                    value={record.category}
                    onChange={(e) => updateRecord(record.id, 'category', e.target.value as Category)}
                    className="h-10 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm"
                  >
                    {CATEGORY_OPTIONS.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">wallGraphRole</p>
                  <select
                    value={record.wallGraphRole}
                    onChange={(e) => updateRecord(record.id, 'wallGraphRole', e.target.value as WallGraphRole)}
                    className="h-10 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm"
                  >
                    {WALL_GRAPH_OPTIONS.map((role) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">openingSignal</p>
                  <select
                    value={record.openingSignal || ''}
                    onChange={(e) => updateRecord(record.id, 'openingSignal', (e.target.value || undefined) as BlueprintLineRecord['openingSignal'])}
                    className="h-10 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm"
                  >
                    <option value="">none</option>
                    {OPENING_OPTIONS.map((signal) => (
                      <option key={signal} value={signal}>{signal}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">promptPriority</p>
                  <Input
                    type="number"
                    min={1}
                    max={9999}
                    value={record.promptPriority}
                    onChange={(e) => updateRecord(record.id, 'promptPriority', Math.max(1, Number(e.target.value || 1)))}
                    className="h-10 rounded-xl"
                  />
                </div>

                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">aliases (comma)</p>
                  <Input
                    value={toAliasString(record.aliases)}
                    onChange={(e) => updateRecord(record.id, 'aliases', fromAliasString(e.target.value))}
                    placeholder="door, dr, entry"
                    className="h-10 rounded-xl"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">cue</p>
                  <Textarea
                    value={record.cue}
                    onChange={(e) => updateRecord(record.id, 'cue', e.target.value)}
                    className="min-h-[80px] rounded-xl"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">meaning</p>
                  <Textarea
                    value={record.meaning}
                    onChange={(e) => updateRecord(record.id, 'meaning', e.target.value)}
                    className="min-h-[80px] rounded-xl"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">caution</p>
                  <Textarea
                    value={record.caution}
                    onChange={(e) => updateRecord(record.id, 'caution', e.target.value)}
                    className="min-h-[80px] rounded-xl"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-slate-500 font-medium">
        Last update: {meta?.updatedAt ? new Date(meta.updatedAt).toLocaleString() : 'N/A'}
        {meta?.updatedBy?.name ? ` | by ${meta.updatedBy.name}` : ''}
      </div>
    </div>
  );
}
