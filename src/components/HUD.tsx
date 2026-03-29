interface HUDProps {
  locationName: string;
  visitorName: string;
}

export function HUD({ locationName }: HUDProps) {
  return (
    <>
      <div className="absolute top-3 left-3">
        <div className="bg-[#1e1b2e]/80 border border-[#3d3654]/30 rounded px-3 py-1.5">
          <p className="text-[#c4b5a0]/70 text-[9px] font-mono">{locationName}</p>
        </div>
      </div>

      <div className="absolute bottom-3 left-3">
        <div className="bg-[#1e1b2e]/60 rounded px-2 py-1">
          <p className="text-[#c4b5a0]/25 text-[7px] font-mono">WASD to move</p>
        </div>
      </div>
    </>
  );
}
