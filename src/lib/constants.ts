import { Home, FileText, Upload, Settings, Gavel, Users, MessageSquare, Send, History, BarChart3, Box, Zap, ClipboardList } from 'lucide-react';

export const LS_KEYS = {
  token: 'infralith_token',
  project: 'infralith_current_project',
  user: 'infralith_user_name',
  avatar: 'infralith_user_avatar',
  email: 'infralith_email',
  logs: 'infralith_logs',
  resume: 'infralith_resume_temp',
};

const mainNav = {
  key: 'main',
  label: '',
  items: [
    { key: 'home', label: 'Overview', icon: Home, auth: false },
    { key: 'upload', label: 'Document Upload', icon: Upload, auth: true, roles: ['Engineer', 'Admin'] },
    { key: 'blueprint3d', label: '2D to 3D AI Gen', icon: Box, auth: true, roles: ['Engineer', 'Admin'] },
    { key: 'simulation', label: 'Smart Site Simulator', icon: Zap, auth: true, roles: ['Engineer', 'Admin'] },
    { key: 'history', label: 'Document History', icon: History, auth: true, roles: ['Engineer', 'Supervisor', 'Admin'] },
  ],
};

const pipelineNav = {
  key: 'pipeline',
  label: 'AI Agents & Orchestration',
  items: [
    { key: 'chat', label: 'Infralith Chat Agent', icon: MessageSquare, auth: true },
  ],
};

const communicationNav = {
  key: 'communication',
  label: 'Communication',
  items: [
    { key: 'messages', label: 'Team Messages', icon: Send, auth: true },
    { key: 'community', label: 'Global Community', icon: Users, auth: true },
  ],
};

const decisionNav = {
  key: 'decision',
  label: 'Decision',
  items: [
    { key: 'decision', label: 'Decision Hub', icon: Gavel, auth: true, roles: ['Engineer', 'Admin'] },
    { key: 'report', label: 'Final Report', icon: FileText, auth: true },
    { key: 'analytics', label: 'Admin Analytics', icon: BarChart3, auth: true, roles: ['Admin'] },
    { key: 'audit', label: 'Audit Log', icon: ClipboardList, auth: true, roles: ['Supervisor', 'Admin'] },
  ],
};

const accountNav = {
  key: 'account',
  label: 'Account',
  items: [
    { key: 'settings', label: 'Settings', icon: Settings, auth: true },
  ],
};

export const navGroups = [mainNav, pipelineNav, communicationNav, decisionNav, accountNav];

export const navItems = [...mainNav.items, ...pipelineNav.items, ...communicationNav.items, ...decisionNav.items, ...accountNav.items];