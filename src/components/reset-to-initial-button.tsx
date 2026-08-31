'use client';

import { cn } from '@/lib/utils';

export function ResetToInitialButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'mt-1 px-2 py-0.5 text-[10px] font-medium rounded-md border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 whitespace-nowrap',
        className
      )}
      title="Reset to the simulation initial price"
    >
      Reset to Initial
    </button>
  );
}
