import React, { useState } from 'react';
import { Crown, Shield, Sword, Check, ArrowLeft } from 'lucide-react';
import { cn } from '../utils/cn';
import { Language, translations } from '../utils/i18n';

export type EmpireType = 'rim' | 'tim' | 'fim';

interface Empire {
  id: EmpireType;
  name: string;
  fullName: string;
  image: string;
  color: string;
  description: string;
}

const getEmpires = (lang: Language): Empire[] => [
  {
    id: 'rim',
    name: translations[lang].russianEmpire,
    fullName: 'Russian Empire',
    image: '/rim.png',
    color: '#1e3a8a', // Dark Blue
    description: lang === 'ru' ? 'Могущественная северная держава с огромными ресурсами и стойким духом.' : 
                 lang === 'tr' ? 'Muazzam kaynaklara ve sarsılmaz bir ruha sahip güçlü bir kuzey gücü.' :
                 'A powerful northern power with vast resources and an indomitable spirit.'
  },
  {
    id: 'tim',
    name: translations[lang].ottomanEmpire,
    fullName: 'Ottoman Empire',
    image: '/tim.jpg',
    color: '#991b1b', // Dark Red
    description: lang === 'ru' ? 'Великая империя, объединяющая восток и запад своей несокрушимой мощью.' :
                 lang === 'tr' ? 'Doğu ve batıyı sarsılmaz gücüyle birleştiren большой imparatorluk.' :
                 'A great empire uniting east and west with its unbreakable power.'
  },
  {
    id: 'fim',
    name: translations[lang].frenchEmpire,
    fullName: 'French Empire',
    image: '/fim.png',
    color: '#1e40af', // Blue
    description: lang === 'ru' ? 'Центр культуры и военной стратегии Европы под знаменем Наполеона.' :
                 lang === 'tr' ? 'Napolyon sancağı altında Avrupa\'nın kültür ve askeri strateji merkezi.' :
                 'The center of European culture and military strategy under Napoleon\'s banner.'
  }
];

interface SelectionScreenProps {
  onSelect: (empire: Empire) => void;
  onBack?: () => void;
  language: Language;
}

const SelectionScreen: React.FC<SelectionScreenProps> = ({ onSelect, language }) => {
  const [selectedId, setSelectedId] = useState<EmpireType | null>(null);
  const t = translations[language];
  const empires = getEmpires(language);

  const handleNext = () => {
    if (selectedId) {
      const empire = empires.find(e => e.id === selectedId);
      if (empire) onSelect(empire);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-start md:justify-center p-4 md:p-6 z-[200] overflow-y-auto custom-scrollbar">
      <div className="w-full max-w-6xl animate-in fade-in zoom-in duration-700 py-12 md:py-0">
        <div className="text-center mb-8 md:mb-12">
          <h1 className="text-4xl sm:text-6xl md:text-8xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 uppercase tracking-tighter mb-4 px-4">
            Empires.io
          </h1>
          <p className="text-slate-400 font-bold uppercase tracking-[0.2em] md:tracking-[0.3em] text-[10px] md:text-sm px-4">
            {t.selectEmpire}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8 mb-8 md:mb-12 px-2 md:px-0">
          {empires.map((empire) => (
            <div
              key={empire.id}
              onClick={() => setSelectedId(empire.id)}
              className={cn(
                "relative group cursor-pointer transition-all duration-500 transform",
                selectedId === empire.id 
                  ? "scale-[1.02] md:scale-105" 
                  : "hover:scale-[1.01] md:hover:scale-102 opacity-80 md:opacity-70 hover:opacity-100"
              )}
            >
              <div className={cn(
                "absolute inset-0 blur-2xl transition-opacity duration-500",
                selectedId === empire.id ? "opacity-30 md:opacity-40" : "opacity-0 group-hover:opacity-20"
              )} style={{ backgroundColor: empire.color }} />
              
              <div className={cn(
                "relative h-full bg-slate-900/80 backdrop-blur-xl border-2 rounded-[1.5rem] md:rounded-[2.5rem] p-6 md:p-8 flex flex-row md:flex-col items-center md:items-center transition-all duration-500",
                selectedId === empire.id 
                  ? "border-indigo-500 shadow-2xl shadow-indigo-500/20" 
                  : "border-white/5 hover:border-white/20"
              )}>
                <div className="w-20 h-20 sm:w-24 sm:h-24 md:w-40 md:h-40 flex-shrink-0 rounded-full overflow-hidden mb-0 md:mb-6 border-2 md:border-4 border-white/10 shadow-xl relative">
                  <img 
                    src={empire.image} 
                    alt={empire.name} 
                    className="w-full h-full object-cover"
                  />
                  {selectedId === empire.id && (
                    <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center backdrop-blur-sm">
                      <Check className="text-white w-8 h-8 md:w-12 md:h-12" />
                    </div>
                  )}
                </div>

                <div className="ml-4 md:ml-0 flex flex-col items-start md:items-center text-left md:text-center overflow-hidden">
                  <h3 className="text-lg sm:text-xl md:text-2xl font-black text-white uppercase tracking-tight mb-1 md:mb-2 truncate w-full">
                    {empire.name}
                  </h3>
                  <p className="text-[8px] md:text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2 md:mb-4">
                    {empire.fullName}
                  </p>
                  
                  <p className="text-slate-400 text-[10px] md:text-sm mb-3 md:mb-6 leading-relaxed font-medium line-clamp-2 md:line-clamp-none">
                    {empire.description}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-center pb-8 md:pb-0">
          <button
            onClick={handleNext}
            disabled={!selectedId}
            className={cn(
              "w-full md:w-auto px-12 md:px-16 py-4 md:py-6 rounded-[1.5rem] md:rounded-[2rem] font-black text-xl md:text-2xl uppercase tracking-[0.2em] transition-all duration-300 shadow-2xl",
              selectedId
                ? "bg-indigo-600 text-white hover:bg-indigo-500 hover:scale-105 active:scale-95 shadow-indigo-500/40"
                : "bg-slate-800 text-slate-600 cursor-not-allowed opacity-50"
            )}
          >
            {selectedId ? t.playNow : t.selectEmpire}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SelectionScreen;