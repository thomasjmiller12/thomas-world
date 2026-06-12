
// You can write more code here

/* START OF COMPILED CODE */

/* START-USER-IMPORTS */
import { InteriorState, initInterior, setupInterior, updateInterior } from './InteriorHelper';
import { placeTownObject } from '../objects/TownObjects';
/* END-USER-IMPORTS */

export default class Workshop extends Phaser.Scene {

	constructor() {
		super("Workshop");

		/* START-USER-CTR-CODE */
		// Write your code here.
		/* END-USER-CTR-CODE */
	}

	editorCreate(): void {

		// workshopMap
		this.cache.tilemap.add("workshopMap_bac83e60-b8fe-4851-b0de-6f0c2a0a3396", {
			format: 1,
			data: {
				width: 20,
				height: 15,
				orientation: "orthogonal",
				tilewidth: 16,
				tileheight: 16,
				tilesets: [
					{
						columns: 32,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1280,
						firstgid: 1,
						image: "Room_Builder_Walls_16x16",
						name: "Room_Builder_Walls_16x16",
						imagewidth: 512,
						imageheight: 640,
					},
					{
						columns: 15,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 600,
						firstgid: 1281,
						image: "Room_Builder_Floors_16x16",
						name: "Room_Builder_Floors_16x16",
						imagewidth: 240,
						imageheight: 640,
					},
					{
						columns: 45,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 450,
						firstgid: 1881,
						image: "Room_Builder_borders_16x16",
						name: "Room_Builder_borders_16x16",
						imagewidth: 720,
						imageheight: 160,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1248,
						firstgid: 2331,
						image: "1_Generic_Black_Shadow_16x16",
						name: "1_Generic_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 1248,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 112,
						firstgid: 3579,
						image: "7_Art_Black_Shadow_16x16",
						name: "7_Art_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 112,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1952,
						firstgid: 3691,
						image: "22_Museum_Black_Shadow_16x16",
						name: "22_Museum_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 1952,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1248,
						firstgid: 5643,
						image: "16_Grocery_store_Black_Shadow_16x16",
						name: "16_Grocery_store_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 1248,
					},
					{
						columns: 8,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 8,
						firstgid: 6891,
						image: "collisions_objects",
						name: "collisions_objects",
						imagewidth: 128,
						imageheight: 16,
					},
				],
				layers: [
					{
						type: "tilelayer",
						name: "floor",
						width: 20,
						height: 15,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1705, 1706, 1706, 1706, 1706, 1706, 1706, 0, 1706, 1706, 1706, 1706, 1706, 1706, 1706, 1706, 0, 0, 0, 0, 1720, 1721, 1721, 1721, 1721, 1721, 1721, 0, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 0, 0, 0, 0, 1720, 1721, 1721, 1721, 1721, 1721, 1721, 1706, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 0, 0, 0, 0, 1720, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 0, 0, 0, 0, 1720, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 0, 0, 0, 0, 1720, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 0, 0, 0, 0, 1720, 1721, 1721, 1721, 1721, 1721, 1721, 0, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 0, 0, 0, 0, 1720, 1721, 1721, 1721, 1721, 1721, 1721, 0, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 1721, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "walls",
						width: 20,
						height: 15,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2157, 514, 514, 514, 514, 514, 514, 514, 2116, 514, 514, 515, 6335, 513, 514, 514, 514, 2159, 0, 0, 2202, 546, 546, 546, 546, 546, 546, 546, 2118, 546, 546, 547, 6351, 545, 546, 546, 546, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 516, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 548, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 2200, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 2118, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 2247, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2245, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2249, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "furnitures",
						width: 20,
						height: 15,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3229, 3230, 2806, 3229, 3230, 2372, 0, 3099, 3033, 3034, 0, 0, 4033, 4034, 0, 0, 0, 0, 0, 3287, 3245, 3246, 2822, 3245, 3246, 2388, 0, 3115, 3049, 3050, 0, 0, 4049, 4050, 0, 0, 0, 0, 0, 3303, 3261, 3262, 0, 3261, 3262, 2621, 4008, 0, 0, 0, 0, 0, 3596, 3597, 3598, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4024, 0, 0, 0, 0, 0, 3875, 3876, 3668, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2923, 2924, 2924, 2925, 2926, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2939, 2940, 2940, 2941, 2942, 0, 0, 0, 0, 3636, 0, 0, 3636, 0, 0, 0, 0, 0, 0, 0, 2955, 6728, 2959, 2957, 2958, 0, 0, 0, 0, 3688, 0, 0, 3688, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3583, 3584, 0, 0, 0, 0, 6655, 6656, 0, 0, 0, 0, 3303, 0, 6656, 6622, 0, 0, 3580, 3581, 3599, 3600, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "furnitureTops",
						width: 20,
						height: 15,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3195, 3196, 0, 3197, 3198, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3211, 3212, 0, 3213, 3214, 2605, 0, 0, 0, 0, 0, 0, 3580, 3581, 3582, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3859, 3860, 3652, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6686, 0, 0, 0, 0, 0, 3620, 0, 0, 3620, 0, 0, 0, 0, 0, 0, 0, 0, 6712, 0, 6702, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3287, 0, 0, 6606, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3287, 3304, 0, 0, 0, 3829, 3830, 0, 0, 3582, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "collisions",
						width: 20,
						height: 15,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 0, 0, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 0, 0, 6891, 6891, 0, 0, 0, 0, 0, 0, 6891, 0, 0, 0, 0, 0, 6891, 6891, 6891, 6891, 0, 0, 6891, 0, 0, 0, 0, 0, 0, 0, 6891, 0, 0, 0, 0, 0, 0, 0, 6891, 6891, 0, 0, 6891, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6891, 0, 0, 6891, 0, 0, 6891, 6891, 6891, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6891, 0, 0, 6891, 0, 0, 6891, 6891, 6891, 0, 0, 0, 0, 0, 6891, 0, 0, 6891, 0, 0, 6891, 0, 0, 6891, 0, 0, 6891, 0, 0, 0, 0, 0, 0, 0, 6891, 0, 0, 6891, 0, 0, 6891, 0, 0, 6891, 0, 0, 0, 0, 0, 0, 6891, 6891, 0, 0, 0, 0, 0, 0, 0, 0, 6891, 0, 0, 6891, 6891, 6891, 0, 0, 0, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 0, 0, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 6891, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "spawns",
						width: 20,
						height: 15,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6892, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
				],
			},
		});
		const workshopMap = this.add.tilemap("workshopMap_bac83e60-b8fe-4851-b0de-6f0c2a0a3396");
		workshopMap.addTilesetImage("Room_Builder_Walls_16x16");
		workshopMap.addTilesetImage("Room_Builder_Floors_16x16");
		workshopMap.addTilesetImage("Room_Builder_borders_16x16");
		workshopMap.addTilesetImage("1_Generic_Black_Shadow_16x16");
		workshopMap.addTilesetImage("7_Art_Black_Shadow_16x16");
		workshopMap.addTilesetImage("22_Museum_Black_Shadow_16x16");
		workshopMap.addTilesetImage("16_Grocery_store_Black_Shadow_16x16");
		workshopMap.addTilesetImage("collisions_objects");

		// floor
		workshopMap.createLayer("floor", ["Room_Builder_Floors_16x16"], 0, 0);

		// walls
		workshopMap.createLayer("walls", ["Room_Builder_borders_16x16","Room_Builder_Walls_16x16","16_Grocery_store_Black_Shadow_16x16"], 0, 0);

		// furnitures
		workshopMap.createLayer("furnitures", ["1_Generic_Black_Shadow_16x16","22_Museum_Black_Shadow_16x16","7_Art_Black_Shadow_16x16","16_Grocery_store_Black_Shadow_16x16"], 0, 0);

		// furnitureTops
		workshopMap.createLayer("furnitureTops", ["1_Generic_Black_Shadow_16x16","7_Art_Black_Shadow_16x16","22_Museum_Black_Shadow_16x16","16_Grocery_store_Black_Shadow_16x16"], 0, 0);

		// collisions
		workshopMap.createLayer("collisions", ["collisions_objects"], 0, 0);

		// spawns
		workshopMap.createLayer("spawns", ["collisions_objects"], 0, 0);

		this.workshopMap = workshopMap;

		this.events.emit("scene-awake");
	}

	private workshopMap!: Phaser.Tilemaps.Tilemap;

	/* START-USER-CODE */

	private state: InteriorState = {} as InteriorState;

	init(data: { returnX?: number; returnY?: number; visitorName?: string }) {
		initInterior(this, data, this.state);
	}

	create() {
		this.editorCreate();
		setupInterior(this, this.workshopMap, 'builder', { x: 128, y: 128 }, 'The Workshop', this.state);
		// The big wall monitor (world fixture: project logs display) between the
		// tool benches and the door, and the work lamp (flickerable) standing by
		// the main work table. Positions via render_map.py.
		const monitor = placeTownObject(this, 'wall-screen-dark-framed', 137, 75, { depth: 20 });
		if (monitor) this.state.fixtures?.register('workshop', 'monitor', monitor);
		const lamp = placeTownObject(this, 'floor-lamp-grey', 52, 148, {
			depth: 20,
			collideWith: this.state.player,
		});
		if (lamp) this.state.fixtures?.register('workshop', 'lamp', lamp);
	}

	update() {
		updateInterior(this.state);
	}

	/* END-USER-CODE */
}

/* END OF COMPILED CODE */

// You can write more code here
