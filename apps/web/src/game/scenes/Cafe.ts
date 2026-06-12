
// You can write more code here

/* START OF COMPILED CODE */

/* START-USER-IMPORTS */
import { InteriorState, initInterior, setupInterior, updateInterior } from './InteriorHelper';
import { placeTownObject } from '../objects/TownObjects';
/* END-USER-IMPORTS */

export default class Cafe extends Phaser.Scene {

	constructor() {
		super("Cafe");

		/* START-USER-CTR-CODE */
		// Write your code here.
		/* END-USER-CTR-CODE */
	}

	editorCreate(): void {

		// cafeMap
		this.cache.tilemap.add("cafeMap_e5a09415-8166-4ea6-affd-f50e4c72ab14", {
			format: 1,
			data: {
				width: 15,
				height: 18,
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
						tilecount: 784,
						firstgid: 2331,
						image: "12_Kitchen_Black_Shadow_16x16",
						name: "12_Kitchen_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 784,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 720,
						firstgid: 3115,
						image: "2_LivingRoom_Black_Shadow_16x16",
						name: "2_LivingRoom_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 720,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 112,
						firstgid: 3835,
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
						tilecount: 1248,
						firstgid: 3947,
						image: "16_Grocery_store_Black_Shadow_16x16",
						name: "16_Grocery_store_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 1248,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1712,
						firstgid: 5195,
						image: "19_Hospital_Black_Shadow_16x16",
						name: "19_Hospital_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 1712,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1248,
						firstgid: 6907,
						image: "1_Generic_Black_Shadow_16x16",
						name: "1_Generic_Black_Shadow_16x16",
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
						firstgid: 8155,
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
						width: 15,
						height: 18,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1465, 1350, 1350, 1350, 1466, 1466, 1466, 1466, 1466, 0, 0, 0, 0, 0, 0, 1480, 1365, 1365, 1365, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1480, 1481, 1481, 1481, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1480, 1481, 1481, 1481, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1480, 1481, 1481, 1481, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1370, 1370, 1370, 1370, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1353, 1354, 1354, 1354, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1368, 1369, 1369, 1369, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1368, 1369, 1369, 1369, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1368, 1369, 1369, 1369, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1368, 1369, 1369, 1369, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1368, 1369, 1369, 1369, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 1368, 1369, 1369, 1369, 1481, 1481, 1481, 1481, 1481, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "walls",
						width: 15,
						height: 18,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2157, 450, 451, 7582, 449, 450, 450, 450, 450, 450, 2159, 0, 0, 0, 0, 2202, 482, 483, 7598, 481, 482, 482, 482, 482, 482, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 2432, 2432, 2432, 2403, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 2500, 2500, 2500, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2202, 0, 0, 0, 2419, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 2247, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2249, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "furnitures",
						width: 15,
						height: 18,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5421, 0, 0, 0, 7603, 7604, 5351, 5352, 0, 0, 0, 0, 0, 0, 0, 5437, 0, 0, 0, 7619, 7620, 5367, 5368, 0, 0, 0, 0, 0, 0, 0, 5453, 0, 0, 0, 0, 0, 5383, 5384, 5453, 0, 0, 0, 0, 0, 0, 4236, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4252, 0, 0, 0, 0, 2513, 2690, 2544, 0, 0, 0, 0, 0, 0, 0, 4268, 0, 0, 0, 0, 2529, 2706, 2560, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4388, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4498, 4499, 0, 4403, 0, 2513, 2690, 2544, 0, 0, 0, 0, 0, 0, 0, 4514, 4515, 0, 4420, 0, 2529, 2706, 2560, 0, 0, 0, 0, 0, 0, 0, 0, 4578, 0, 4417, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2933, 0, 0, 0, 0, 2513, 2690, 2544, 0, 0, 0, 0, 0, 0, 0, 2949, 0, 0, 0, 0, 2529, 2706, 2560, 0, 0, 0, 0, 0, 0, 0, 2965, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2949, 0, 0, 0, 0, 2513, 2690, 2544, 0, 0, 0, 0, 0, 0, 0, 2965, 0, 0, 0, 0, 2529, 2706, 2560, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "furnitureTops",
						width: 15,
						height: 18,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5421, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5437, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2689, 0, 2691, 0, 0, 0, 0, 0, 0, 0, 0, 2943, 2944, 0, 0, 2705, 0, 2707, 0, 0, 0, 0, 0, 0, 0, 0, 2959, 2960, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2689, 0, 2691, 0, 0, 0, 0, 0, 0, 0, 0, 4562, 0, 0, 0, 2705, 0, 2707, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2689, 0, 2691, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2705, 0, 2707, 0, 0, 0, 0, 0, 0, 0, 2933, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2689, 0, 2691, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2705, 0, 2707, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "collisions",
						width: 15,
						height: 18,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8155, 8155, 8155, 0, 0, 8155, 8155, 8155, 8155, 8155, 8155, 0, 0, 0, 0, 8155, 8155, 8155, 0, 0, 8155, 8155, 8155, 8155, 8155, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 0, 0, 0, 0, 0, 8155, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 0, 0, 0, 0, 0, 0, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 0, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 0, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 8155, 8155, 8155, 8155, 0, 0, 0, 0, 0, 8155, 0, 0, 0, 0, 8155, 8155, 8155, 8155, 8155, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 0, 0, 0, 8155, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 0, 0, 0, 8155, 0, 0, 0, 0, 0, 8155, 0, 0, 0, 0, 8155, 0, 0, 0, 8155, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 8155, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 8155, 0, 0, 0, 0, 0, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 8155, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 8155, 0, 0, 8155, 0, 8155, 8155, 8155, 0, 8155, 0, 0, 0, 0, 8155, 8155, 8155, 8155, 8155, 8155, 8155, 8155, 8155, 8155, 8155, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "spawns",
						width: 15,
						height: 18,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
				],
			},
		});
		const cafeMap = this.add.tilemap("cafeMap_e5a09415-8166-4ea6-affd-f50e4c72ab14");
		cafeMap.addTilesetImage("Room_Builder_Walls_16x16");
		cafeMap.addTilesetImage("Room_Builder_Floors_16x16");
		cafeMap.addTilesetImage("Room_Builder_borders_16x16");
		cafeMap.addTilesetImage("12_Kitchen_Black_Shadow_16x16");
		cafeMap.addTilesetImage("2_LivingRoom_Black_Shadow_16x16");
		cafeMap.addTilesetImage("7_Art_Black_Shadow_16x16");
		cafeMap.addTilesetImage("16_Grocery_store_Black_Shadow_16x16");
		cafeMap.addTilesetImage("19_Hospital_Black_Shadow_16x16");
		cafeMap.addTilesetImage("1_Generic_Black_Shadow_16x16");
		cafeMap.addTilesetImage("collisions_objects");

		// floor
		cafeMap.createLayer("floor", ["Room_Builder_Floors_16x16"], 0, 0);

		// walls
		cafeMap.createLayer("walls", ["Room_Builder_borders_16x16","Room_Builder_Walls_16x16","1_Generic_Black_Shadow_16x16","12_Kitchen_Black_Shadow_16x16"], 0, 0);

		// furnitures
		cafeMap.createLayer("furnitures", ["19_Hospital_Black_Shadow_16x16","1_Generic_Black_Shadow_16x16","16_Grocery_store_Black_Shadow_16x16","12_Kitchen_Black_Shadow_16x16"], 0, 0);

		// furnitureTops
		cafeMap.createLayer("furnitureTops", ["19_Hospital_Black_Shadow_16x16","12_Kitchen_Black_Shadow_16x16","16_Grocery_store_Black_Shadow_16x16"], 0, 0);

		// collisions
		cafeMap.createLayer("collisions", ["collisions_objects"], 0, 0);

		// spawns
		cafeMap.createLayer("spawns", [], 0, 0);

		this.cafeMap = cafeMap;

		this.events.emit("scene-awake");
	}

	private cafeMap!: Phaser.Tilemaps.Tilemap;

	/* START-USER-CODE */

	private state: InteriorState = {} as InteriorState;

	init(data: { returnX?: number; returnY?: number; visitorName?: string }) {
		initInterior(this, data, this.state);
	}

	create() {
		this.editorCreate();
		setupInterior(this, this.cafeMap, 'writer', { x: 160, y: 144 }, 'The Cafe', this.state);
		// The espresso machine (world fixture: agents hiss it for ambiance) on the
		// empty counter section left of the donut display. Position via render_map.py.
		const espresso = placeTownObject(this, 'coffee-machine', 57, 117, { depth: 20 });
		if (espresso) this.state.fixtures?.register('cafe', 'espresso machine', espresso);
	}

	update() {
		updateInterior(this.state);
	}

	/* END-USER-CODE */
}

/* END OF COMPILED CODE */

// You can write more code here
