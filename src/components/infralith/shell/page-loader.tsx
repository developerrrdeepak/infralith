'use client';

import { motion } from 'framer-motion';
import { HardHat } from 'lucide-react';

export default function PageLoader() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background z-[100] overflow-hidden">
      {/* Blueprint Grid Background - subtle */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>

      <div className="relative flex flex-col items-center gap-8">
        {/* Animated Construction Hexagon/Logo */}
        <div className="relative w-32 h-32 flex items-center justify-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
            className="absolute inset-0 border-2 border-dashed border-primary/40 rounded-full"
          />
          <motion.div
            animate={{ rotate: -360 }}
            transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
            className="absolute inset-2 border-2 border-primary/20 rounded-full"
          />

          {/* Inner Content - Pulse */}
          <motion.div
            animate={{ scale: [0.95, 1.05, 0.95] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            className="relative bg-primary/10 p-4 rounded-2xl border border-primary/30 backdrop-blur-sm shadow-[0_0_30px_rgba(245,158,11,0.2)]"
          >
            <HardHat className="w-10 h-10 text-primary" />
          </motion.div>
        </div>

        {/* Loading Text */}
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-xl font-bold tracking-widest uppercase text-foreground">
            Infralith <span className="text-primary font-black">AI</span>
          </h2>

          {/* Progress Bar */}
          <div className="w-48 h-1 bg-muted rounded-full overflow-hidden relative">
            <motion.div
              className="absolute top-0 left-0 h-full bg-primary"
              initial={{ width: "0%" }}
              animate={{ width: "100%" }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>

          <p className="text-xs text-muted-foreground uppercase tracking-[0.2em] font-medium mt-2 animate-pulse">
            Analyzing Structural Data...
          </p>
        </div>
      </div>
    </div>
  );
}
