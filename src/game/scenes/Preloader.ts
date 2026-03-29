// You can write more code here

/* START OF COMPILED CODE */

import Phaser from "phaser";
/* START-USER-IMPORTS */
/* END-USER-IMPORTS */

export default class Preloader extends Phaser.Scene {

	constructor() {
		super("Preloader");

		/* START-USER-CTR-CODE */
		// Write your code here.
		/* END-USER-CTR-CODE */
	}

	editorCreate(): void {

		// background
		this.add.image(512, 384, "background");

		// progressBar
		const progressBar = this.add.rectangle(512, 384, 468, 32);
		progressBar.isFilled = true;
		progressBar.fillColor = 14737632;
		progressBar.isStroked = true;

		this.progressBar = progressBar;

		this.events.emit("scene-awake");
	}

	private progressBar!: Phaser.GameObjects.Rectangle;

	/* START-USER-CODE */

    init ()
    {
        // Skip editorCreate - it references deleted template assets
        const w = this.cameras.main.width;
        const h = this.cameras.main.height;

        const progressBox = this.add.rectangle(w / 2, h / 2, 200, 16, 0x222222);
        progressBox.isStroked = true;
        progressBox.strokeColor = 0x444444;

        const bar = this.add.rectangle(w / 2 - 96, h / 2, 4, 12, 0x4A90D9);

        this.load.on('progress', (progress: number) => {
            bar.width = 4 + (192 * progress);
        });
    }

    preload ()
    {
        // Use the 'pack' file to load in any assets you need for this scene
        this.load.pack('preload', 'assets/preload-asset-pack.json');
    }

    create ()
    {
        this.createAnimations();
        this.scene.start('Town');
    }

    private createAnimations() {
        const sprites = ['player', 'thomas-career', 'thomas-researcher', 'thomas-builder', 'thomas-writer', 'thomas-hobby'];

        // Spritesheets: 64x96, 4 cols x 4 rows, 16x24 frames
        // Row 0 (frames 0-3): down
        // Row 1 (frames 4-7): left
        // Row 2 (frames 8-11): right
        // Row 3 (frames 12-15): up
        // RPG Maker pattern per row: idle, step-left, idle, step-right

        for (const sprite of sprites) {
            // Down (row 0)
            this.anims.create({
                key: `${sprite}-idle-down`,
                frames: [{ key: sprite, frame: 0 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-down`,
                frames: [
                    { key: sprite, frame: 0 },
                    { key: sprite, frame: 1 },
                    { key: sprite, frame: 2 },
                    { key: sprite, frame: 3 },
                ],
                frameRate: 8,
                repeat: -1,
            });

            // Left (row 1)
            this.anims.create({
                key: `${sprite}-idle-left`,
                frames: [{ key: sprite, frame: 4 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-left`,
                frames: [
                    { key: sprite, frame: 4 },
                    { key: sprite, frame: 5 },
                    { key: sprite, frame: 6 },
                    { key: sprite, frame: 7 },
                ],
                frameRate: 8,
                repeat: -1,
            });

            // Right (row 2)
            this.anims.create({
                key: `${sprite}-idle-right`,
                frames: [{ key: sprite, frame: 8 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-right`,
                frames: [
                    { key: sprite, frame: 8 },
                    { key: sprite, frame: 9 },
                    { key: sprite, frame: 10 },
                    { key: sprite, frame: 11 },
                ],
                frameRate: 8,
                repeat: -1,
            });

            // Up (row 3)
            this.anims.create({
                key: `${sprite}-idle-up`,
                frames: [{ key: sprite, frame: 12 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-up`,
                frames: [
                    { key: sprite, frame: 12 },
                    { key: sprite, frame: 13 },
                    { key: sprite, frame: 14 },
                    { key: sprite, frame: 15 },
                ],
                frameRate: 8,
                repeat: -1,
            });
        }
    }
    /* END-USER-CODE */
}

/* END OF COMPILED CODE */

// You can write more code here
