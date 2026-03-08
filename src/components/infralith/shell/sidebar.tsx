
'use client';
import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { navGroups } from '@/lib/constants';
import { useAppContext } from '@/contexts/app-context';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export default function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { activeRoute, handleNavigate, authed, user } = useAppContext();

  const isAuthorized = (item: any) => {
    if (!item.auth) return true;
    if (!authed) return false;
    if (!item.roles) return true;
    return item.roles.includes(user?.role);
  };

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'border-r premium-glass border-l-0 border-y-0 rounded-none shadow-[8px_0_32px_0_var(--glass-shadow)]',
          'transition-all duration-300 ease-in-out',
          collapsed ? 'w-20' : 'w-64',
          'hidden md:flex flex-col z-20'
        )}
      >
        <nav className="flex-1 p-3 space-y-2 overflow-y-auto scrollbar-none custom-scrollbar">
          {navGroups.map((group) => {
            const visibleItems = group.items.filter(item => isAuthorized(item));
            if (visibleItems.length === 0 && group.key !== 'main') return null;

            if (group.key === 'main' || (group.key !== 'main' && authed)) {
              return (
                <div key={group.key}>
                  {group.label && !collapsed && visibleItems.length > 0 && (
                    <h4 className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{group.label}</h4>
                  )}
                  {visibleItems.map((item) => {
                    const Icon = item.icon;
                    const content = (
                      <button
                        key={item.key}
                        onClick={() => handleNavigate(item.key)}
                        className={cn(
                          'w-full flex items-center gap-4 rounded-lg px-3 py-2.5 mb-1 text-sm font-medium transition-colors',
                          collapsed && 'justify-center',
                          item.key === activeRoute
                            ? 'bg-primary/10 text-primary'
                            : 'hover:bg-muted text-foreground/70 hover:text-foreground',
                          'cursor-pointer'
                        )}
                      >
                        <Icon className="h-5 w-5 shrink-0" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </button>
                    );

                    return collapsed ? (
                      <Tooltip key={`${item.key}-tooltip`}>
                        <TooltipTrigger asChild>{content}</TooltipTrigger>
                        <TooltipContent side="right">
                          <p>{item.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      content
                    );
                  })}
                </div>
              );
            }
            return null;
          })}
        </nav>
        {!authed && !collapsed && (
          <div className="p-4 border-t border-white/10">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-accent" />
              <p className="text-xs text-muted-foreground">
                Sign in via Entra ID to unlock evaluation modules
              </p>
            </div>
          </div>
        )}
      </aside>
    </TooltipProvider>
  );
}
