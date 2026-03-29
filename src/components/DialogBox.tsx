import { useEffect, useCallback } from 'react';

interface DialogBoxProps {
  text: string;
  title?: string;
  onClose: () => void;
}

export function DialogBox({ text, title, onClose }: DialogBoxProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 -translate-x-1/2 max-w-md w-full mx-4" onClick={onClose}>
      <div className="bg-black/90 border-2 border-white/30 rounded-lg px-6 py-4 shadow-2xl">
        {title && <h3 className="text-white text-xs mb-2 font-mono">{title}</h3>}
        <p className="text-gray-200 text-sm leading-relaxed">{text}</p>
        <p className="text-gray-500 text-[8px] mt-3 text-right font-mono">[SPACE] to close</p>
      </div>
    </div>
  );
}
