import React, { useState, useRef, useEffect, useCallback } from 'react';

interface JoystickProps {
  onMove: (x: number, y: number) => void;
  onEnd?: () => void;
}

const Joystick: React.FC<JoystickProps> = ({ onMove, onEnd }) => {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isActive, setIsActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleStart = (e: React.TouchEvent | React.MouseEvent) => {
    setIsActive(true);
    handleMove(e);
  };

  const handleMove = useCallback((e: TouchEvent | MouseEvent | React.TouchEvent | React.MouseEvent) => {
    if (!isActive || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const maxDistance = rect.width / 2;

    const limitedDistance = Math.min(distance, maxDistance);
    const angle = Math.atan2(dy, dx);

    const nx = Math.cos(angle) * limitedDistance;
    const ny = Math.sin(angle) * limitedDistance;

    setPosition({ x: nx, y: ny });
    onMove(nx / maxDistance, ny / maxDistance);
  }, [isActive, onMove]);

  const handleEnd = useCallback(() => {
    setIsActive(false);
    setPosition({ x: 0, y: 0 });
    onMove(0, 0);
    if (onEnd) onEnd();
  }, [onEnd, onMove]);

  useEffect(() => {
    if (isActive) {
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
    } else {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
    }
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [isActive, handleMove, handleEnd]);

  return (
    <div
      ref={containerRef}
      className="relative w-32 h-32 bg-white/10 rounded-full border-2 border-white/20 touch-none select-none backdrop-blur-sm"
      onMouseDown={handleStart}
      onTouchStart={handleStart}
    >
      <div
        className="absolute w-12 h-12 bg-white/40 rounded-full border-2 border-white/60 pointer-events-none transition-transform duration-75"
        style={{
          left: '50%',
          top: '50%',
          transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`,
        }}
      />
    </div>
  );
};

export default Joystick;
