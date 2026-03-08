
'use client';

import { useAppContext } from '@/contexts/app-context';
import { navGroups } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { ShieldCheck } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export default function MobileSidebar() {
  const { isMobileMenuOpen, setIsMobileMenuOpen, activeRoute, handleNavigate, authed, user } = useAppContext();

  const isAuthorized = (item: any) => {
    if (!item.auth) return true;
    if (!authed) return false;
    if (!item.roles) return true;
    return item.roles.includes(user?.role);
  };

  return (
    <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
      <SheetContent side="left" className="p-0 w-72 bg-card/80 backdrop-blur-lg border-r border-white/10">
        <SheetHeader className="p-4 border-b border-white/10 h-[69px] flex items-center">
          <SheetTitle className="sr-only">Mobile Menu</SheetTitle>
          <div className="font-headline font-bold tracking-tight text-xl">
            <span className="text-foreground">Infra</span>
            <span className="text-primary">lith</span>
          </div>
        </SheetHeader>
        <div className="flex flex-col h-[calc(100%-69px)]">
          <nav className="flex-1 p-4 space-y-2">
            {navGroups.map((group) => {
              const visibleItems = group.items.filter((item) => isAuthorized(item));
              if (group.key === 'main' || (group.key !== 'main' && authed)) {
                return (
                  <div key={group.key}>
                    {group.label && visibleItems.length > 0 && <h4 className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{group.label}</h4>}
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const disabled = item.auth && !authed;
                      return (
                        <button
                          key={item.key}
                          disabled={disabled}
                          onClick={() => handleNavigate(item.key)}
                          className={cn(
                            "w-full flex items-center gap-4 rounded-lg px-3 py-2.5 mb-1 text-sm font-medium",
                            item.key === activeRoute
                              ? "bg-primary/10 text-primary"
                              : "hover:bg-muted text-foreground/70",
                            disabled && "opacity-50 cursor-not-allowed"
                          )}
                        >
                          <Icon className="h-5 w-5" />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )
              }
              return null;
            })}
          </nav>
          {!authed && (
            <div className="p-4 border-t border-white/10">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-accent" />
                <p className="text-xs text-muted-foreground">
                  Sign in via Entra ID to unlock evaluation modules
                </p>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
