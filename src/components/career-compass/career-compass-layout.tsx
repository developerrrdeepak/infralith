'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppContext } from '@/contexts/app-context';
import Header from './header';
import Sidebar from './sidebar';
import MobileSidebar from './mobile-sidebar';
import LoginDialog from './login-dialog';
import GatePlaceholder from './gate-placeholder';
import TwinklingStars from './twinkling-stars';
import Footer from './footer';
import ProfilePage from './profile-page';
import SettingsPage from './settings-page';
import ChatPage from './chat-page';
import DMPage from './dm-page';
import { cn } from '@/lib/utils';
import RoleSelectionDialog from './role-selection-dialog';
import GuestDashboard from '@/components/infralith/GuestDashboard';

// Infralith Construction Intelligence Modules
import DashboardHome from '@/components/infralith/DashboardHome';
import BlueprintUpload from '@/components/infralith/BlueprintUpload';
import PipelineStatus from '@/components/infralith/PipelineStatus';
import ComplianceView from '@/components/infralith/ComplianceView';
import RiskView from '@/components/infralith/RiskView';
import CostPrediction from '@/components/infralith/CostPrediction';
import DecisionPanel from '@/components/infralith/DecisionPanel';
import ReportView from '@/components/infralith/ReportView';
import CommunityPage from '@/components/infralith/CommunityPage';
import AzureAISearchView from '@/components/infralith/AzureAISearch';
import VirtualWarRoom from '@/components/infralith/VirtualWarRoom';
import BlueprintTo3D from '@/components/infralith/BlueprintTo3D';
import ConferenceRoom from '@/components/infralith/ConferenceRoom';
import BlueprintHistory from '@/components/infralith/BlueprintHistory';
import AnalyticsPanel from '@/components/infralith/AnalyticsPanel';
import SmartSiteSimulator from '@/components/infralith/SmartSiteSimulator';
import AuditLogPanel from '@/components/infralith/AuditLogPanel';
import BlueprintLineDbAdminPanel from '@/components/infralith/BlueprintLineDbAdminPanel';
import { NotificationProvider } from '@/components/infralith/NotificationBell';

export default function CareerCompassLayout() {
  const { activeRoute, authed, showLogin, user } = useAppContext();
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(true);
  const isGuest = authed && user?.role === 'Guest';

  const gated = (component: React.ReactNode) =>
    authed ? component : <GatePlaceholder />;

  const componentMap: { [key: string]: React.ReactNode } = {
    home: isGuest ? <GuestDashboard /> : <DashboardHome />,
    upload: gated(<BlueprintUpload />),
    pipeline: gated(<PipelineStatus />),
    compliance: gated(<ComplianceView />),
    risk: gated(<RiskView />),
    cost: gated(<CostPrediction />),
    decision: gated(<DecisionPanel />),
    report: gated(<ReportView />),
    search: gated(<AzureAISearchView />),
    chat: gated(<ChatPage />),
    messages: gated(<DMPage />),
    community: gated(<CommunityPage />),
    profile: gated(<ProfilePage />),
    settings: gated(<SettingsPage />),
    warroom: gated(<VirtualWarRoom />),
    blueprint3d: gated(<BlueprintTo3D />),
    conference: gated(<ConferenceRoom />),
    history: gated(<BlueprintHistory />),
    analytics: gated(<AnalyticsPanel />),
    'line-db-admin': gated(<BlueprintLineDbAdminPanel />),
    simulation: gated(<SmartSiteSimulator />),
    audit: gated(<AuditLogPanel />),
  };

  const pageVariants = {
    initial: { opacity: 0, y: 15 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
    exit: { opacity: 0, y: -15, transition: { duration: 0.2, ease: [0.32, 0, 0.67, 0] } },
  };

  return (
    <NotificationProvider>
      <>
        <TwinklingStars />
        <div className="h-screen w-full text-foreground font-body relative flex flex-col">
          <Header
            desktopSidebarCollapsed={desktopSidebarCollapsed}
            onToggleDesktopSidebar={() => setDesktopSidebarCollapsed((c) => !c)}
          />

          <div className="flex h-[calc(100vh-69px)]">
            {authed && !isGuest && (
              <>
                <Sidebar collapsed={desktopSidebarCollapsed} />
                <MobileSidebar />
              </>
            )}

            <main className={cn('flex-1 relative', 'p-4 md:p-6 space-y-6 overflow-y-auto')}>
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeRoute}
                  variants={pageVariants as any}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  {componentMap[activeRoute] ?? <DashboardHome />}
                </motion.div>
              </AnimatePresence>
              {activeRoute === 'home' && <Footer />}
            </main>
          </div>
        </div>

        <AnimatePresence>
          {showLogin && <LoginDialog />}
        </AnimatePresence>

        {/* Keep RoleSelectionDialog as fallback for edge cases */}
        {!isGuest && <RoleSelectionDialog />}
      </>
    </NotificationProvider>
  );
}
