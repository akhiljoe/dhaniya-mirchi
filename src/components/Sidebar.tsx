import type { MainView } from '../types';
import { BarChart3, ChefHat, Home, Receipt, Store, UtensilsCrossed } from 'lucide-react';

import { SHOW_MEAL_PLAN } from '@/lib/constants';

interface SidebarProps {
  activeView: MainView;
  onNavigate: (view: MainView) => void;
}

// No count badge on Supplies. It showed the running-low number in red while
// the heading on that same page said "Order today: 20 things" - and a red
// badge on a tab means unread, everywhere else on a phone.
// `short` is the phone's bottom-nav label: they must fit across 360 px.
const NAV_ITEMS: { id: MainView; label: string; short: string; icon: typeof Home }[] = [
  ...(SHOW_MEAL_PLAN ? [{ id: 'meals' as const, label: 'Plan meals', short: 'Meals', icon: UtensilsCrossed }] : []),
  // The landing page. Not "Kitchen": the household orders toilet cleaner and
  // sanitary pads through the same apps, and a name that says kitchen tells
  // them those do not belong here.
  { id: 'inventory', label: 'What you have', short: 'Supplies', icon: Home },
  { id: 'cook', label: 'Cook something', short: 'Cook', icon: ChefHat },
  { id: 'history', label: 'Purchase history', short: 'History', icon: Receipt },
  { id: 'insights', label: 'Insights', short: 'Insights', icon: BarChart3 },
  { id: 'apps', label: 'Grocery apps', short: 'Apps', icon: Store },
];

export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <>
      {/* Desktop sidebar, under the header (which carries the name) */}
      <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-sand-200 bg-sand-50/80 h-[calc(100vh-3.5rem)] sticky top-14 pt-4">
        <nav className="flex-1 px-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`nav-item w-full ${isActive ? 'nav-item-active' : ''}`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            );
          })}
        </nav>

      </aside>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface/95 backdrop-blur-md border-t border-sand-200 px-2 py-1.5 flex items-center justify-around">
        {NAV_ITEMS.map((item) => {
          const isActive = activeView === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`relative flex-1 min-w-0 flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-lg transition-colors ${
                isActive ? 'text-ink-800' : 'text-ink-300'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-2xs font-medium truncate max-w-full">{item.short}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
