import Boot from './scenes/Boot';
import Preloader from './scenes/Preloader';
import Town from './scenes/Town';
import Office from './scenes/Office';
import Library from './scenes/Library';
import Workshop from './scenes/Workshop';
import Cafe from './scenes/Cafe';
import { AUTO, Game } from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '@/lib/constants';

const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent: 'game-container',
    backgroundColor: '#1a1a2e',
    pixelArt: true,
    physics: {
        default: 'arcade',
        arcade: {
            gravity: { x: 0, y: 0 },
            debug: false,
        },
    },
    scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [
        Boot,
        Preloader,
        Town,
        Office,
        Library,
        Workshop,
        Cafe,
    ]
};

const StartGame = (parent: string) => {

    return new Game({ ...config, parent });

}

export default StartGame;
