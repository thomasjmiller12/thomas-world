interface HUDProps {
  locationName: string;
  visitorName: string;
}

export function HUD({ locationName, visitorName }: HUDProps) {
  return (
    <>
      <div className="absolute top-4 left-4">
        <div className="bg-black/70 border border-white/20 rounded-lg px-4 py-2">
          <p className="text-white text-[10px] font-mono">{locationName}</p>
        </div>
      </div>

      <div className="absolute top-4 right-4">
        <div className="bg-black/70 border border-[#4A90D9]/30 rounded-lg px-4 py-2">
          <p className="text-[#4A90D9] text-[10px] font-mono">{visitorName}</p>
        </div>
      </div>

      <div className="absolute bottom-4 left-4">
        <div className="bg-black/50 rounded-lg px-3 py-1.5">
          <p className="text-gray-500 text-[8px] font-mono">WASD move | SPACE interact</p>
        </div>
      </div>
    </>
  );
}
