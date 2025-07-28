import { useEffect, useState } from "react";

export type AudioWavesProps = {
  isActive: boolean;
  className?: string;
};

export const AudioWaves = ({ isActive, className = "" }: AudioWavesProps) => {
  const [bars, setBars] = useState([0.3, 0.6, 0.8, 0.4, 0.7]);

  useEffect(() => {
    if (!isActive) {
      setBars([0.2, 0.2, 0.2, 0.2, 0.2]);
      return;
    }

    const interval = setInterval(() => {
      setBars(prev => prev.map(() => Math.random() * 0.8 + 0.2));
    }, 150);

    return () => clearInterval(interval);
  }, [isActive]);

  return (
    <div className={`flex h-4 items-end justify-center gap-0.5 ${className}`}>
      {bars.map((height, index) => (
        <div
          key={`bar-${index}`}
          className={`w-0.5 bg-current transition-all duration-150 ${
            isActive ? "opacity-100" : "opacity-30"
          }`}
          style={{
            height: `${height * 100}%`,
            transformOrigin: "bottom",
          }}
        />
      ))}
    </div>
  );
};