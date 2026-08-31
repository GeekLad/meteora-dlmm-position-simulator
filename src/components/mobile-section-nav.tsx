'use client';

import { BarChart3, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';

export const MOBILE_SECTIONS = ['position', 'analysis'] as const;
export type MobileSection = (typeof MOBILE_SECTIONS)[number];

const TABS: {
  id: MobileSection;
  label: string;
  icon: typeof Layers;
}[] = [
  { id: 'position', label: 'Positions', icon: Layers },
  { id: 'analysis', label: 'Analysis', icon: BarChart3 },
];

interface MobileSectionNavProps {
  value: MobileSection;
  onChange: (section: MobileSection) => void;
  hasPosition: boolean;
}

export function MobileSectionNav({ value, onChange, hasPosition }: MobileSectionNavProps) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-primary/20 bg-background/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-md lg:hidden"
      aria-label="Simulator sections"
    >
      <div className="grid h-14 grid-cols-2" role="tablist">
        {TABS.map((tab) => {
          const disabled = tab.id !== 'position' && !hasPosition;
          const active = value === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              disabled={disabled}
              onClick={() => onChange(tab.id)}
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              title={disabled ? 'Create a position to view this section' : tab.label}
              className={cn(
                'relative flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors select-none touch-manipulation',
                active && !disabled && 'text-primary',
                !active && !disabled && 'text-muted-foreground hover:text-foreground',
                disabled && 'cursor-not-allowed text-muted-foreground/40'
              )}
            >
              {active && !disabled && (
                <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-primary" />
              )}
              <Icon className="h-5 w-5" />
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
