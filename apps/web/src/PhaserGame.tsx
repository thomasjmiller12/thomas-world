import { useEffect, useRef } from 'react';
import StartGame from './game/main';

export function PhaserGame() {
  const game = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (game.current === null) {
      game.current = StartGame('game-container');
    }

    return () => {
      if (game.current) {
        game.current.destroy(true);
        game.current = null;
      }
    };
  }, []);

  return <div id="game-container" className="w-full h-full" />;
}
