import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider, useTheme } from './theme';
import DashboardConsumable from './pages/DashboardConsumable';
import DashboardOngoing from './pages/DashboardOngoing';
import Cards from './pages/Cards';
import CardDetail from './pages/CardDetail';
import Programs from './pages/Programs';
import ProgramDetail from './pages/ProgramDetail';
import ManageBenefits from './pages/ManageBenefits';
import BonusCategories from './pages/BonusCategories';
import PointsCurrencies from './pages/PointsCurrencies';
import Refresh from './pages/Refresh';
import Settings from './pages/Settings';
import PrintExpiring from './pages/PrintExpiring';
import RefreshBanner from './components/RefreshBanner';

const NAV = [
  { to: '/',                  label: 'Credits & Usages', end: true },
  { to: '/ongoing',           label: 'Ongoing Benefits' },
  { to: '/cards',             label: 'Cards' },
  { to: '/programs',          label: 'Programs' },
  { to: '/bonus-categories',  label: 'Bonus Categories' },
  { to: '/points-currencies', label: 'Points Values' },
  { to: '/benefits',          label: 'Manage Benefits' },
  { to: '/refresh',           label: 'Refresh' },
  { to: '/settings',          label: 'Settings' },
];

function Shell() {
  const { theme, toggle } = useTheme();
  const [dbPath, setDbPath] = useState('');
  const [version, setVersion] = useState('');

  // v1.0.25: file commands (File menu or Settings) report here so the header,
  // the banner and the open page always show the file that is actually open.
  const [fileEpoch, setFileEpoch] = useState(0);
  const [pageEpoch, setPageEpoch] = useState(0);
  const [fileNotice, setFileNotice] = useState<{ text: string; id: number } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => { window.api.file.currentPath().then(setDbPath); }, []);
  useEffect(() => {
    return window.api.file.onChanged(info => {
      setDbPath(info.path);
      if (info.reload) setFileEpoch(n => n + 1);
      if (info.source !== 'menu') return;          // Settings shows its own result
      if (info.message) { const text = info.message; setFileNotice(prev => ({ text, id: (prev?.id ?? 0) + 1 })); }
      if (info.reload) {
        // A card or program page may point at something the new file does not have.
        if (/^\/(cards|programs)\/./.test(location.pathname)) navigate('/');
        setPageEpoch(n => n + 1);
      }
    });
  }, [location.pathname, navigate]);
  useEffect(() => {
    if (!fileNotice) return;
    const timer = setTimeout(() => setFileNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [fileNotice]);
  useEffect(() => { window.api.app.getVersion().then(setVersion).catch(() => setVersion('')); }, []);
  // v1.0.26: File > Print Expiring Credits opens its screen in this window.
  useEffect(() => {
    return window.api.app.onNavigate(route => {
      if (route !== 'print-expiring' || location.pathname === '/print-expiring') return; // that page prints on Ctrl+P
      // An open form may hold edits that have not been saved; do not leave it behind.
      if (document.querySelector('main .fixed.inset-0')) {
        setFileNotice(prev => ({ text: 'Close the open form first, then choose Print Expiring Credits again.', id: (prev?.id ?? 0) + 1 }));
        return;
      }
      navigate('/print-expiring');
    });
  }, [navigate, location.pathname]);

  return (
    <div className="flex h-full flex-col print:block print:h-auto">
      {/* Two rows so every control stays on screen down to the 1000 x 640 minimum window:
          the title, open file, version and theme on top, the page links underneath. */}
      <header className="print:hidden border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 pt-2.5 pb-2">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <span className="text-lg font-bold text-primary-600">◈</span>
            <span className="text-lg font-bold">Credit Card Benefit Tracker</span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            {/* Long paths are shortened from the left so the file name stays visible; the full path is in the tooltip. */}
            <span className="min-w-0 truncate text-left text-xs text-slate-400 [direction:rtl]" title={dbPath} data-testid="current-file-path"><bdi dir="ltr">{dbPath}</bdi></span>
            <button
              className="btn-ghost shrink-0 whitespace-nowrap text-xs"
              onClick={() => window.api.app.showAbout()}
              title="About Credit Card Benefit Tracker"
            >
              {version ? `v${version}` : 'About'}
            </button>
            <button className="btn-ghost shrink-0 whitespace-nowrap" onClick={toggle} title="Toggle theme">
              {theme === 'dark' ? '☀ Light' : '🌙 Dark'}
            </button>
          </div>
        </div>
        <nav className="mt-2 flex flex-wrap gap-0.5 xl:gap-1" aria-label="Pages">
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `whitespace-nowrap px-2 xl:px-3 py-1.5 rounded-lg text-sm font-medium ${
                  isActive
                    ? 'bg-primary-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <div className="print:hidden"><RefreshBanner key={`banner-${fileEpoch}`} /></div>

      <main className="flex-1 overflow-auto p-6 print:overflow-visible print:p-0" key={`page-${pageEpoch}`}>
        <Routes>
          <Route path="/" element={<DashboardConsumable />} />
          <Route path="/ongoing" element={<DashboardOngoing />} />
          <Route path="/cards" element={<Cards />} />
          <Route path="/cards/:id" element={<CardDetail />} />
          <Route path="/programs" element={<Programs />} />
          <Route path="/programs/:id" element={<ProgramDetail />} />
          <Route path="/bonus-categories" element={<BonusCategories />} />
          <Route path="/points-currencies" element={<PointsCurrencies />} />
          <Route path="/benefits" element={<ManageBenefits />} />
          <Route path="/refresh" element={<Refresh />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/print-expiring" element={<PrintExpiring />} />
        </Routes>
      </main>

      {fileNotice && (
        <div
          role="status"
          className="print:hidden pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-[min(32rem,calc(100vw-2rem))] items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 text-sm shadow-lg"
        >
          <span className="[overflow-wrap:anywhere]">{fileNotice.text}</span>
          <button className="btn-ghost pointer-events-auto text-xs shrink-0" onClick={() => setFileNotice(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
