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

        for (const sprite of sprites) {
            this.anims.create({
                key: `${sprite}-idle-down`,
                frames: [{ key: sprite, frame: 0 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-down`,
                frames: this.anims.generateFrameNumbers(sprite, { start: 0, end: 3 }),
                frameRate: 8,
                repeat: -1,
            });
            this.anims.create({
                key: `${sprite}-idle-up`,
                frames: [{ key: sprite, frame: 4 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-up`,
                frames: this.anims.generateFrameNumbers(sprite, { start: 4, end: 7 }),
                frameRate: 8,
                repeat: -1,
            });
            this.anims.create({
                key: `${sprite}-idle-left`,
                frames: [{ key: sprite, frame: 4 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-left`,
                frames: this.anims.generateFrameNumbers(sprite, { start: 4, end: 7 }),
                frameRate: 8,
                repeat: -1,
            });
            this.anims.create({
                key: `${sprite}-idle-right`,
                frames: [{ key: sprite, frame: 4 }],
                frameRate: 1,
            });
            this.anims.create({
                key: `${sprite}-walk-right`,
                frames: this.anims.generateFrameNumbers(sprite, { start: 4, end: 7 }),
                frameRate: 8,
                repeat: -1,
            });
        }
    }
    /* END-USER-CODE */
}

/* END OF COMPILED CODE */

// You can write more code here
