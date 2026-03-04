'use client';

import { useState } from 'react';
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/contexts/app-context";
import { useNotifications } from "@/components/infralith/NotificationBell";
import { useToast } from "@/hooks/use-toast";
import {
  Settings, Sun, Moon, Monitor, Bell, BellOff, Shield, Database,
  Palette, LogOut, Trash2, User, Globe, ChevronRight,
  CheckCircle, Cloud, Cpu, AlertTriangle
} from "lucide-react";
import { cn } from "@/lib/utils";

type Section = 'appearance' | 'notifications' | 'security' | 'azure' | 'account';

export default function SettingsPage() {
  const { user, toggleTheme, theme, handleLogout } = useAppContext();
  const { addNotification, clearAll } = useNotifications();
  const { toast } = useToast();

  const [activeSection, setActiveSection] = useState<Section>('appearance');
  const [selectedTheme, setSelectedTheme] = useState<'light' | 'dark' | 'system'>(theme === 'dark' ? 'dark' : 'light');
  const [denseLayout, setDenseLayout] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [sessionTimeout, setSessionTimeout] = useState('30');

  const [notifSettings, setNotifSettings] = useState({
    blueprintComplete: true,
    teamMessages: true,
    complianceAlerts: true,
    systemUpdates: false,
  });

  const navItems: { key: Section; label: string; icon: any; desc: string }[] = [
    { key: 'appearance', label: 'Appearance', icon: Palette, desc: 'Theme & display' },
    { key: 'notifications', label: 'Notifications', icon: Bell, desc: 'Alerts & pings' },
    { key: 'security', label: 'Security', icon: Shield, desc: 'Auth & sessions' },
    { key: 'azure', label: 'Azure Services', icon: Cloud, desc: 'API configuration' },
    { key: 'account', label: 'Account', icon: User, desc: 'Profile & data' },
  ];

  const applyTheme = (t: 'light' | 'dark' | 'system') => {
    setSelectedTheme(t);
    if ((t === 'dark') !== (theme === 'dark')) toggleTheme();
    toast({ title: 'Theme Updated', description: `Switched to ${t} mode.` });
  };

  const azureServices = [
    { name: 'Azure OpenAI (GPT-4o)', endpoint: process.env.NEXT_PUBLIC_AZURE_OPENAI_ENDPOINT || 'infralith.centralindia.openai.azure.com' },
    { name: 'Azure Document Intelligence', endpoint: 'infralith.cognitiveservices.azure.com' },
    { name: 'Azure Cosmos DB', endpoint: 'Cosmos DB — East US Region' },
    { name: 'Microsoft Entra ID', endpoint: 'Azure Active Directory SSO' },
  ];

  const sectionContent: Record<Section, { title: string; subtitle: string; icon: any }> = {
    appearance: { title: 'Appearance', subtitle: 'Customize how Infralith looks on your device.', icon: Palette },
    notifications: { title: 'Notifications', subtitle: 'Choose which alerts you want to receive.', icon: Bell },
    security: { title: 'Security', subtitle: 'Manage authentication and session settings.', icon: Shield },
    azure: { title: 'Azure Service Config', subtitle: 'View and verify your connected Azure AI services.', icon: Cloud },
    account: { title: 'Account', subtitle: 'Manage your profile and account actions.', icon: User },
  };

  const active = sectionContent[activeSection];

  return (
    <div className="w-full max-w-5xl mx-auto space-y-8 pb-12">
      {/* Page Header */}
      <div className="flex items-center gap-4">
        <div className="h-11 w-11 bg-amber-50 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center border border-amber-100 dark:border-amber-800 shadow-sm">
          <Settings className="h-6 w-6 text-amber-500" />
        </div>
        <div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Settings</h1>
          <p className="text-slate-500 font-semibold text-sm">Manage workspace, integrations, and platform preferences.</p>
        </div>
      </div>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-start">
        {/* Sidebar Nav */}
        <div className="md:col-span-1 bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden p-2">
          <nav className="space-y-1">
            {navItems.map(item => (
              <button
                key={item.key}
                onClick={() => setActiveSection(item.key)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3.5 rounded-[16px] text-left transition-all",
                  activeSection === item.key
                    ? "bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold leading-none">{item.label}</p>
                  <p className="text-[10px] mt-0.5 opacity-60 hidden lg:block">{item.desc}</p>
                </div>
                <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", activeSection === item.key ? "rotate-90 text-amber-500" : "opacity-20")} />
              </button>
            ))}
          </nav>
        </div>

        {/* Main Panel */}
        <div className="md:col-span-3 bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
          {/* Panel Header */}
          <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-xl font-black text-slate-900 dark:text-white">{active.title}</h2>
            <p className="text-sm text-slate-500 font-medium mt-0.5">{active.subtitle}</p>
          </div>

          <div className="p-8 space-y-8">

            {/* ── APPEARANCE ── */}
            {activeSection === 'appearance' && (
              <div className="space-y-8">
                {/* Theme Picker */}
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Theme</p>
                  <div className="grid grid-cols-3 gap-4">
                    {(['light', 'dark', 'system'] as const).map(t => (
                      <button
                        key={t}
                        onClick={() => applyTheme(t === 'system' ? 'dark' : t)}
                        className={cn(
                          "relative p-5 rounded-[20px] border-2 flex flex-col items-center gap-3 transition-all",
                          selectedTheme === t
                            ? "border-amber-400 bg-amber-50 dark:bg-amber-900/20 shadow-lg shadow-amber-500/10"
                            : "border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-600"
                        )}
                      >
                        {t === 'light' && <Sun className={cn("h-7 w-7", selectedTheme === t ? "text-amber-500" : "text-slate-400")} />}
                        {t === 'dark' && <Moon className={cn("h-7 w-7", selectedTheme === t ? "text-amber-500" : "text-slate-400")} />}
                        {t === 'system' && <Monitor className={cn("h-7 w-7", selectedTheme === t ? "text-amber-500" : "text-slate-400")} />}
                        <span className={cn("text-xs font-black capitalize", selectedTheme === t ? "text-amber-600" : "text-slate-500")}>{t}</span>
                        {selectedTheme === t && (
                          <div className="absolute top-2.5 right-2.5 h-4 w-4 rounded-full bg-amber-500 flex items-center justify-center">
                            <CheckCircle className="h-3 w-3 text-white" strokeWidth={3} />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Toggles */}
                <div className="space-y-0 divide-y divide-slate-100 dark:divide-slate-800">
                  {[
                    { label: 'Dense Layout', desc: 'Compact sidebar and smaller spacing', val: denseLayout, set: setDenseLayout },
                    { label: 'Reduce Motion', desc: 'Disable animations for accessibility', val: reduceMotion, set: setReduceMotion },
                    { label: 'High Contrast Mode', desc: 'Improve visual separation and legibility', val: highContrast, set: setHighContrast },
                  ].map(row => (
                    <div key={row.label} className="flex items-center justify-between py-5 first:pt-0">
                      <div>
                        <p className="font-bold text-slate-800 dark:text-slate-100 text-sm">{row.label}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{row.desc}</p>
                      </div>
                      <Switch
                        checked={row.val}
                        onCheckedChange={v => {
                          row.set(v);
                          toast({ title: row.label, description: v ? 'Enabled.' : 'Disabled.' });
                        }}
                        className="data-[state=checked]:bg-amber-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── NOTIFICATIONS ── */}
            {activeSection === 'notifications' && (
              <div className="space-y-8">
                <div className="space-y-0 divide-y divide-slate-100 dark:divide-slate-800">
                  {[
                    { key: 'blueprintComplete', label: 'Blueprint Analysis Complete', desc: 'Notified when AI pipeline finishes processing.' },
                    { key: 'teamMessages', label: 'Team Messages', desc: 'Ping when a colleague sends you a message.' },
                    { key: 'complianceAlerts', label: 'Compliance Violations', desc: 'Alert when a critical compliance conflict is found.' },
                    { key: 'systemUpdates', label: 'System & Platform Updates', desc: 'Admin announcements and platform-level changes.' },
                  ].map(item => (
                    <div key={item.key} className="flex items-center justify-between py-5 first:pt-0">
                      <div>
                        <p className="font-bold text-slate-800 dark:text-slate-100 text-sm">{item.label}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{item.desc}</p>
                      </div>
                      <Switch
                        checked={notifSettings[item.key as keyof typeof notifSettings]}
                        onCheckedChange={v => setNotifSettings(prev => ({ ...prev, [item.key]: v }))}
                        className="data-[state=checked]:bg-amber-500"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex flex-col sm:flex-row gap-3 pt-2">
                  <Button onClick={() => toast({ title: 'Preferences Saved', description: 'Notification settings updated.' })} className="flex-1 bg-amber-500 hover:bg-amber-400 text-white font-bold shadow-lg shadow-amber-500/20">
                    Save Preferences
                  </Button>
                  <Button onClick={() => { addNotification({ type: 'success', title: 'Test Notification', body: 'Your notification system is working correctly.' }); toast({ title: 'Test Sent' }); }} variant="outline" className="flex-1 border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-900/20 font-bold">
                    Send Test
                  </Button>
                  <Button onClick={clearAll} variant="ghost" className="flex-1 text-slate-400 hover:text-rose-500 font-bold">
                    <BellOff className="h-4 w-4 mr-2" /> Clear All
                  </Button>
                </div>
              </div>
            )}

            {/* ── SECURITY ── */}
            {activeSection === 'security' && (
              <div className="space-y-6">
                {/* Auth Banner */}
                <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800 rounded-[18px] p-5 flex items-center gap-4">
                  <div className="h-10 w-10 bg-emerald-100 dark:bg-emerald-900/40 rounded-xl flex items-center justify-center shrink-0">
                    <Shield className="h-5 w-5 text-emerald-500" />
                  </div>
                  <div>
                    <p className="font-black text-emerald-700 dark:text-emerald-400 text-sm">Microsoft Entra ID Active</p>
                    <p className="text-xs text-emerald-600/70 dark:text-emerald-500/70 mt-0.5">Session is secured via Azure Active Directory enterprise authentication.</p>
                  </div>
                </div>

                <div className="space-y-0 divide-y divide-slate-100 dark:divide-slate-800">
                  <div className="flex items-center justify-between py-5">
                    <div>
                      <p className="font-bold text-slate-800 dark:text-slate-100 text-sm">Two-Factor Authentication</p>
                      <p className="text-xs text-slate-400 mt-0.5">Enforced by your Azure AD tenant policy</p>
                    </div>
                    <Badge className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 font-bold text-[11px] rounded-full px-3">Enforced</Badge>
                  </div>
                  <div className="flex items-center justify-between py-5">
                    <div>
                      <p className="font-bold text-slate-800 dark:text-slate-100 text-sm">Session Timeout</p>
                      <p className="text-xs text-slate-400 mt-0.5">Auto-expire session after this many minutes of inactivity</p>
                    </div>
                    <Input type="number" value={sessionTimeout} onChange={e => setSessionTimeout(e.target.value)} className="w-20 h-9 text-center font-bold text-sm border-slate-200 dark:border-slate-700 rounded-xl" />
                  </div>
                </div>

                {/* Active Sessions */}
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Active Sessions</p>
                  <div className="space-y-3">
                    {[
                      { device: 'Chrome on Windows 11', location: 'Mumbai, IN', time: 'Active now', current: true },
                      { device: 'Infralith Mobile App', location: 'Bangalore, IN', time: '2 hours ago', current: false },
                    ].map((s, i) => (
                      <div key={i} className="flex items-center justify-between p-4 rounded-[16px] bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                        <div>
                          <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{s.device}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{s.location} · {s.time}</p>
                        </div>
                        {s.current ? (
                          <Badge className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 border border-emerald-200 dark:border-emerald-700 text-[10px] font-black rounded-full px-3">Current</Badge>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-8 px-3 text-xs text-rose-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 font-bold rounded-xl">Revoke</Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── AZURE SERVICES ── */}
            {activeSection === 'azure' && (
              <div className="space-y-6">
                <div className="space-y-3">
                  {azureServices.map((svc, i) => (
                    <div key={i} className="flex items-center justify-between p-5 rounded-[18px] bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                      <div className="flex items-center gap-4">
                        <div className="h-10 w-10 bg-white dark:bg-slate-700 rounded-xl flex items-center justify-center border border-slate-200 dark:border-slate-600 shadow-sm shrink-0">
                          <Cpu className="h-5 w-5 text-amber-500" />
                        </div>
                        <div>
                          <p className="font-bold text-slate-800 dark:text-slate-100 text-sm">{svc.name}</p>
                          <p className="text-xs text-slate-400 font-mono mt-0.5">{svc.endpoint}</p>
                        </div>
                      </div>
                      <Badge className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-700 font-bold text-[10px] rounded-full px-3 flex items-center gap-1.5 shrink-0">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Configured
                      </Badge>
                    </div>
                  ))}
                </div>
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-[18px] p-5 flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                    API keys are managed via <span className="font-bold font-mono">.env.local</span> and are never exposed to the client. Azure Key Vault integration is recommended for production deployment.
                  </p>
                </div>
              </div>
            )}

            {/* ── ACCOUNT ── */}
            {activeSection === 'account' && (
              <div className="space-y-6">
                {/* Profile Card */}
                <div className="flex items-center gap-5 p-5 rounded-[20px] bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                  <div className="h-16 w-16 rounded-2xl bg-amber-100 dark:bg-amber-900/40 border-2 border-amber-200 dark:border-amber-700 flex items-center justify-center text-amber-600 dark:text-amber-400 font-black text-2xl shrink-0">
                    {user?.name?.[0]?.toUpperCase() || 'U'}
                  </div>
                  <div>
                    <p className="font-black text-lg text-slate-900 dark:text-white tracking-tight">{user?.name || 'Unknown User'}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{user?.email || '—'}</p>
                    <Badge className="mt-2 bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-700 text-[11px] font-black rounded-full px-3">{user?.role || 'Engineer'}</Badge>
                  </div>
                </div>

                {/* Action Links */}
                <div className="space-y-1">
                  {[
                    { label: 'Edit Profile', icon: User, action: () => toast({ title: 'Navigate to Profile', description: 'Go to "My Profile" from the top-right menu.' }) },
                    { label: 'Change Language', icon: Globe, action: () => toast({ title: 'Coming Soon', description: 'Multi-language support coming in v2.' }) },
                    { label: 'Export My Data', icon: Database, action: () => toast({ title: 'Export Started', description: 'Your data export will be ready shortly.' }) },
                  ].map(item => (
                    <button
                      key={item.label}
                      onClick={item.action}
                      className="w-full flex items-center justify-between px-4 py-4 rounded-[16px] hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors group"
                    >
                      <div className="flex items-center gap-3">
                        <item.icon className="h-4 w-4 text-slate-400 group-hover:text-amber-500 transition-colors" />
                        <span className="text-sm font-bold text-slate-700 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-white transition-colors">{item.label}</span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-300 dark:text-slate-600" />
                    </button>
                  ))}
                </div>

                {/* Danger Zone */}
                <div className="border-t border-slate-100 dark:border-slate-800 pt-6 space-y-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Danger Zone</p>
                  <Button
                    variant="outline"
                    onClick={handleLogout}
                    className="w-full border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold h-11 rounded-[14px] justify-start gap-3 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <LogOut className="h-4 w-4" /> Sign Out
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (confirm('Are you sure? This action is permanent and cannot be undone.')) {
                        localStorage.clear();
                        sessionStorage.clear();
                        handleLogout();
                      }
                    }}
                    className="w-full text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 hover:text-rose-500 font-bold h-11 rounded-[14px] justify-start gap-3"
                  >
                    <Trash2 className="h-4 w-4" /> Delete Account
                  </Button>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
