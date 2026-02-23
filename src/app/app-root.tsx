'use client';

import { useEffect } from 'react';
import { useAppContext } from '@/contexts/app-context';

export default function AppRoot({ children }: { children: React.ReactNode }) {
  const { theme } = useAppContext();

  useEffect(() => {
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('THREE.Clock: This module has been deprecated')) {
        return;
      }
      originalWarn(...args);
    };
    return () => {
      console.warn = originalWarn;
    };
  }, []);

  return <div className={theme}>{children}</div>;
}

