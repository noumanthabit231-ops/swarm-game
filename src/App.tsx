import { useState, useEffect } from 'react';
import SwarmEngine from './components/SwarmEngine';
import SelectionScreen, { EmpireType } from './components/SelectionScreen';
import IntroScreen from './components/IntroScreen';
import { Language } from './utils/i18n';

function App() {
  const [showIntro, setShowIntro] = useState(true);
  const [selectedEmpire, setSelectedEmpire] = useState<{ id: EmpireType; color: string } | null>(null);
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem('jan_lang');
    if (saved === 'ru' || saved === 'en' || saved === 'tr') return saved as Language;
    return 'ru'; // Default
  });

  useEffect(() => {
    localStorage.setItem('jan_lang', language);
  }, [language]);

  if (showIntro) {
    return <IntroScreen onFinish={() => setShowIntro(false)} />;
  }

  return (
    <div className="w-full h-screen overflow-hidden bg-slate-950 select-none relative">
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[200] flex gap-2">
        {(['en', 'ru', 'tr'] as const).map((lang) => (
          <button
            key={lang}
            onClick={() => setLanguage(lang)}
            className={`w-10 h-10 rounded-xl font-black text-xs transition-all ${
              language === lang 
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' 
                : 'bg-slate-900/80 text-slate-500 hover:bg-slate-800'
            } border border-white/5 uppercase`}
          >
            {lang}
          </button>
        ))}
      </div>
      {!selectedEmpire ? (
        <SelectionScreen 
          onSelect={(empire) => setSelectedEmpire({ id: empire.id, color: empire.color })} 
          language={language}
        />
      ) : (
        <SwarmEngine 
          initialEmpire={selectedEmpire} 
          onBack={() => setSelectedEmpire(null)}
          language={language}
        />
      )}
    </div>
  );
}

export default App;
