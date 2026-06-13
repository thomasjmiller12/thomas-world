import { useEffect, useRef } from 'react';
import StartGame from './game/main';

export function PhaserGame({ observe = false }: { observe?: boolean }) {
  const game = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (game.current === null) {
      game.current = StartGame('game-container');
      // Scenes read this to render the player as a translucent ghost.
      game.current.registry.set('observeMode', observe);
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
