'use client';

import { useEffect, useState } from 'react';

const SPARK_COUNT = 30;

export default function TwinklingStars() {
  const [sparks, setSparks] = useState<any[]>([]);

  useEffect(() => {
    const generatedSparks = Array.from({ length: SPARK_COUNT }).map(() => {
      return {
        left: `${Math.random() * 100}%`,
        top: `${Math.random() * -20}%`, // Start above the viewport
        '--drift': `${(Math.random() - 0.5) * 300}px`, // Random horizontal drift between -150px and +150px
        '--duration': `${1.5 + Math.random() * 4}s`, // Varied animation duration for realism
        animationDelay: `${Math.random() * 6}s`, // Varied stagger
      };
    });
    setSparks(generatedSparks);
  }, []);

  return (
    <div id="stars-container">
      {sparks.map((style, index) => (
        <div key={index} className="spark" style={style} />
      ))}
    </div>
  );
}
