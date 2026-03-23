import React, { useEffect, useState } from 'react';
import { translations } from '../utils/i18n';

const IntroScreen: React.FC<{ onFinish: () => void }> = ({ onFinish }) => {
  const [show, setShow] = useState(true);
  const [lang] = useState(() => {
    const saved = localStorage.getItem('jan_lang');
    return (saved === 'ru' || saved === 'en' || saved === 'tr') ? saved : 'ru';
  });
  const t = translations[lang];

  useEffect(() => {
    const timer = setTimeout(() => {
      setShow(false);
      setTimeout(onFinish, 500); // Wait for fade out animation
    }, 2000);
    return () => clearTimeout(timer);
  }, [onFinish]);

  return (
    <div className={`fixed inset-0 bg-slate-950 z-[300] flex flex-col items-center justify-center transition-opacity duration-500 p-4 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
      <div className="relative w-full max-w-4xl h-64 md:h-96 flex items-end justify-center gap-2 md:gap-12 px-2 md:px-6">
        
        {/* Russian Warrior */}
        <div className="flex flex-col items-center animate-in slide-in-from-left-20 duration-1000 ease-out">
          <div className="w-16 h-16 sm:w-24 sm:h-24 md:w-40 md:h-40 rounded-full border-2 md:border-4 border-blue-500/30 overflow-hidden shadow-[0_0_20px_rgba(59,130,246,0.2)] mb-2 md:mb-4">
            <img src="/rim.png" alt="Russian Warrior" className="w-full h-full object-cover scale-110" />
          </div>
          <div className="h-0.5 md:h-1 w-10 md:w-16 bg-blue-500/50 rounded-full blur-sm animate-pulse" />
        </div>

        {/* Ottoman Janissary (Center) */}
        <div className="flex flex-col items-center animate-in slide-in-from-bottom-20 duration-1000 ease-out delay-150">
          <div className="w-20 h-20 sm:w-32 sm:h-32 md:w-56 md:h-56 rounded-full border-2 md:border-4 border-red-600/40 overflow-hidden shadow-[0_0_30px_rgba(220,38,38,0.3)] mb-3 md:mb-6 z-10 relative">
            <img src="/tim.jpg" alt="Ottoman Janissary" className="w-full h-full object-cover scale-110" />
          </div>
          <div className="h-1 md:h-1.5 w-16 md:w-24 bg-red-600/60 rounded-full blur-sm animate-pulse" />
        </div>

        {/* French Warrior */}
        <div className="flex flex-col items-center animate-in slide-in-from-right-20 duration-1000 ease-out delay-300">
          <div className="w-16 h-16 sm:w-24 sm:h-24 md:w-40 md:h-40 rounded-full border-2 md:border-4 border-blue-600/30 overflow-hidden shadow-[0_0_20px_rgba(37,99,235,0.2)] mb-2 md:mb-4">
            <img src="/fim.png" alt="French Warrior" className="w-full h-full object-cover scale-110" />
          </div>
          <div className="h-0.5 md:h-1 w-10 md:w-16 bg-blue-600/50 rounded-full blur-sm animate-pulse" />
        </div>

      </div>

      <div className="mt-8 md:mt-12 text-center animate-in fade-in zoom-in duration-1000 delay-500 px-4">
        <h1 className="text-4xl sm:text-6xl md:text-8xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 uppercase tracking-tighter mb-2">
          {t.gameTitle}
        </h1>
        <div className="flex items-center justify-center gap-2">
          <div className="h-[1px] w-12 bg-slate-800" />
          <p className="text-slate-500 font-bold uppercase tracking-[0.5em] text-[10px]">{lang === 'ru' ? 'Приготовьтесь к битве' : lang === 'tr' ? 'Savaşa Hazırlan' : 'Prepare for Battle'}</p>
          <div className="h-[1px] w-12 bg-slate-800" />
        </div>
      </div>

      {/* Decorative background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/4 w-96 h-96 bg-indigo-500/5 blur-[120px] rounded-full -translate-y-1/2" />
        <div className="absolute top-1/2 right-1/4 w-96 h-96 bg-emerald-500/5 blur-[120px] rounded-full -translate-y-1/2" />
      </div>
    </div>
  );
};

export default IntroScreen;
